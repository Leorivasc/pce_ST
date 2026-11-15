/*
 * pce_st - PCE's Atari ST core as a library
 *
 * Replaces PCE's src/arch/atarist/main.c (which is not linked): it builds the
 * machine from a configuration text and exposes a small API for JS: stepping
 * by exact cycles or frames, video, audio, input, media and state. There is no
 * main loop and no dependency on SDL or on the real clock.
 *
 * PCE code is Copyright (C) Hampa Hug. This file is distributed under the
 * GNU GPL version 2, like PCE.
 */

#include <stdio.h>
#include <stdint.h>
#include <time.h>
#include <stdarg.h>
#include <string.h>

#include <emscripten.h>

#include <config.h>

#include <arch/atarist/main.h>
#include <arch/atarist/atarist.h>
#include <arch/atarist/msg.h>
#include <arch/atarist/psg.h>
#include <arch/atarist/video.h>

#include <cpu/e68000/e68000.h>
#include <devices/memory.h>
#include <drivers/sound/sound.h>
#include <drivers/video/terminal.h>
#include <lib/log.h>
#include <lib/monitor.h>
#include <lib/path.h>
#include <lib/sysdep.h>
#include <libini/libini.h>


/* Symbols that PCE expects to find in main.c */
int         par_verbose = 0;
const char  *par_terminal = NULL;
atari_st_t  *par_sim = NULL;
monitor_t   par_mon;
ini_sct_t   *par_cfg = NULL;

void sim_stop (void)
{
	if (par_sim != NULL) {
		par_sim->brk = PCE_BRK_STOP;
	}
}

void st_log_deb (const char *msg, ...)
{
	va_list       va;
	unsigned long pc;

	pc = (par_sim != NULL) ? e68_get_last_pc (par_sim->cpu, 0) : 0;

	pce_log (MSG_DEB, "[%06lX] ", pc & 0xffffff);

	va_start (va, msg);
	pce_log_va (MSG_DEB, msg, va);
	va_end (va);
}


/*
 * Wall clock. The RTC and the IKBD read the host's time()/localtime().
 * For deterministic tests an initial time can be fixed with pce_st_set_time();
 * from then on the time advances only with emulated time and localtime()
 * returns UTC. A negative value goes back to the real time.
 * The link step uses --wrap=time --wrap=localtime (see scripts/build-core.sh).
 */
static int    wall_fixed = 0;
static double wall_base = 0.0;

time_t __real_time (time_t *t);
struct tm *__real_localtime (const time_t *t);

time_t __wrap_time (time_t *t)
{
	time_t val;

	if (wall_fixed && (par_sim != NULL)) {
		val = (time_t) (wall_base + (double) st_get_clkcnt (par_sim) / ST_CPU_CLOCK);

		if (t != NULL) {
			*t = val;
		}

		return (val);
	}

	return (__real_time (t));
}

struct tm *__wrap_localtime (const time_t *t)
{
	return (wall_fixed ? gmtime (t) : __real_localtime (t));
}

EMSCRIPTEN_KEEPALIVE
void pce_st_set_time (double secs)
{
	wall_fixed = (secs >= 0.0);
	wall_base = secs;
}


/*
 * Audio queue. The PSG delivers blocks of 16-bit samples and stops completely
 * while it is silent, so its stream has gaps. To make the audio follow emulated
 * time, at the end of every step the queue is padded with zeros up to the
 * expected number of samples (cycles * rate / 8 MHz).
 * JS collects the queue after every step.
 */
#define AUDIO_MAX 65536

static int16_t            audio_buf[AUDIO_MAX];
static unsigned           audio_cnt = 0;
static unsigned           audio_dropped = 0;
static unsigned long long audio_total = 0;

static
void audio_push (int16_t val)
{
	if (audio_cnt < AUDIO_MAX) {
		audio_buf[audio_cnt++] = val;
	}
	else {
		audio_dropped += 1;
	}

	audio_total += 1;
}

static
void audio_sync (void)
{
	unsigned long long expected;

	expected = st_get_clkcnt (par_sim) * par_sim->psg.srate / ST_CPU_CLOCK;

	while (audio_total < expected) {
		audio_push (0);
	}
}

static
int audio_write (sound_drv_t *sdrv, const uint16_t *buf, unsigned cnt)
{
	unsigned i;

	/* The PSG generates UNSIGNED 16-bit samples with zero at 0x8000
	 * (psg_add_sample); they are converted to signed int16, where 0 is silence. */
	for (i = 0; i < cnt; i++) {
		audio_push ((int16_t) (buf[i] ^ 0x8000));
	}

	return (0);
}


#define GLUE_GUARD_CYCLES 4000000UL

static char hash_str[17];


/*
 * Creates the machine. cfg is PCE's configuration text (libini format), for
 * example the contents of pce-atarist.cfg. Returns 0 on success.
 */
EMSCRIPTEN_KEEPALIVE
int pce_st_init (const char *cfg)
{
	ini_sct_t *sct;

	if (par_sim != NULL) {
		return (1);
	}

	pce_log_init();
	pce_log_add_fp (stderr, 0, MSG_INF);

	par_cfg = ini_sct_new (NULL);

	if ((par_cfg == NULL) || ini_read_str (par_cfg, cfg)) {
		return (2);
	}

	sct = ini_next_sct (par_cfg, NULL, "atarist");

	if (sct == NULL) {
		sct = par_cfg;
	}

	pce_path_ini (sct);

	par_sim = st_new (sct);

	if (par_sim == NULL) {
		return (3);
	}

	/* Audio goes to our queue instead of to a device. */
	if (st_psg_get_driver (&par_sim->psg) != NULL) {
		st_psg_get_driver (&par_sim->psg)->write = audio_write;
	}

	st_reset (par_sim);

	return (0);
}

EMSCRIPTEN_KEEPALIVE
void pce_st_reset (void)
{
	st_reset (par_sim);
}

/*
 * Advances n clock units (multiples of 16; 8 000 000 per second).
 */
EMSCRIPTEN_KEEPALIVE
int pce_st_step_cycles (unsigned long n)
{
	while (n >= 16) {
		st_clock (par_sim, 0);
		n -= 16;

		if (par_sim->brk) {
			audio_sync();
			return (1);
		}
	}

	audio_sync();

	return (0);
}

/*
 * Advances until a video frame is complete. Returns 0 if it completed one,
 * 1 if the machine stopped, -1 if it did not within the safety limit.
 */
EMSCRIPTEN_KEEPALIVE
int pce_st_step_frame (void)
{
	unsigned      frame;
	unsigned long guard;

	frame = par_sim->video->frame;

	for (guard = 0; guard < GLUE_GUARD_CYCLES; guard += 16) {
		st_clock (par_sim, 0);

		if (par_sim->brk) {
			audio_sync();
			return (1);
		}

		if (par_sim->video->frame != frame) {
			audio_sync();
			return (0);
		}
	}

	audio_sync();

	return (-1);
}

EMSCRIPTEN_KEEPALIVE
double pce_st_clock_count (void)
{
	return ((double) st_get_clkcnt (par_sim));
}

EMSCRIPTEN_KEEPALIVE
unsigned pce_st_frame_count (void)
{
	return (par_sim->video->frame);
}


/* Video: RGB buffer, 3 bytes per pixel, with the current width and height. */
EMSCRIPTEN_KEEPALIVE
const unsigned char *pce_st_video_buf (void)
{
	return (par_sim->trm->buf);
}

EMSCRIPTEN_KEEPALIVE
unsigned pce_st_video_width (void)
{
	return (par_sim->trm->w);
}

EMSCRIPTEN_KEEPALIVE
unsigned pce_st_video_height (void)
{
	return (par_sim->trm->h);
}


/* Audio: samples pending since the last call to pce_st_audio_clear. */
EMSCRIPTEN_KEEPALIVE
const int16_t *pce_st_audio_buf (void)
{
	return (audio_buf);
}

EMSCRIPTEN_KEEPALIVE
unsigned pce_st_audio_count (void)
{
	return (audio_cnt);
}

EMSCRIPTEN_KEEPALIVE
unsigned pce_st_audio_rate (void)
{
	return (par_sim->psg.srate);
}

EMSCRIPTEN_KEEPALIVE
unsigned pce_st_audio_dropped (void)
{
	return (audio_dropped);
}

EMSCRIPTEN_KEEPALIVE
void pce_st_audio_clear (void)
{
	audio_cnt = 0;
}


/* Input. event: 1 = press, 2 = release; key: pce_key_t code. */
EMSCRIPTEN_KEEPALIVE
void pce_st_key (unsigned event, unsigned key)
{
	trm_set_key (par_sim->trm, event, (pce_key_t) key);
}

/* Relative mouse motion and buttons (bit 0 = left, bit 1 = right, bit 2 = middle). */
EMSCRIPTEN_KEEPALIVE
void pce_st_mouse (int dx, int dy, unsigned buttons)
{
	trm_set_mouse (par_sim->trm, dx, dy, buttons);
}

/*
 * Key code from its name. PCE's name table calls the "i" key "I" and has no
 * name for the right Shift, so those two are resolved here. Returns 0
 * (PCE_KEY_NONE) if the name does not exist.
 */
EMSCRIPTEN_KEEPALIVE
unsigned pce_st_key_from_name (const char *name)
{
	if (strcmp (name, "i") == 0) {
		return ((unsigned) PCE_KEY_I);
	}

	if (strcmp (name, "ShiftRight") == 0) {
		return ((unsigned) PCE_KEY_RSHIFT);
	}

	return ((unsigned) pce_key_from_string (name));
}


/* PCE messages (media, reset, etc.). Returns 0 if accepted. */
EMSCRIPTEN_KEEPALIVE
int pce_st_msg (const char *msg, const char *val)
{
	return (st_set_msg (par_sim, msg, val));
}


/*
 * Floppy disks. PCE keeps the decoded image in memory and only saves it to the
 * file on eject or reset. pce_st_disk_flush saves it now, without ejecting, so
 * that JS can read the updated file. drive: 0 (A:) or 1 (B:).
 * Returns 0 if saved (or there were no changes), non-zero if there is no disk
 * or it failed.
 */
EMSCRIPTEN_KEEPALIVE
int pce_st_disk_flush (unsigned drive)
{
	unsigned id;

	if (drive > 1) {
		return (1);
	}

	if (st_fdc_save (&par_sim->fdc, drive)) {
		return (1);
	}

	id = par_sim->fdc.diskid[drive];

	if (id < 0xffff) {
		dsks_set_msg (par_sim->dsks, id, "commit", NULL);
	}

	return (0);
}

/* 1 if the guest has written to the floppy since it was last saved. */
EMSCRIPTEN_KEEPALIVE
int pce_st_disk_modified (unsigned drive)
{
	return ((drive < 2) && par_sim->fdc.modified[drive]);
}


/* State for debugging and tests. */
EMSCRIPTEN_KEEPALIVE
unsigned pce_st_peek8 (unsigned long addr)
{
	return (mem_get_uint8 (par_sim->mem, addr & 0xffffff));
}

EMSCRIPTEN_KEEPALIVE
void pce_st_poke8 (unsigned long addr, unsigned val)
{
	mem_set_uint8 (par_sim->mem, addr & 0xffffff, val & 0xff);
}

EMSCRIPTEN_KEEPALIVE
double pce_st_reg (const char *name)
{
	unsigned long val;

	if (e68_get_reg (par_sim->cpu, name, &val)) {
		return (-1.0);
	}

	return ((double) val);
}

EMSCRIPTEN_KEEPALIVE
unsigned long pce_st_ram_size (void)
{
	return (mem_blk_get_size (par_sim->ram));
}

static
uint64_t hash_bytes (uint64_t h, const unsigned char *p, unsigned long n)
{
	unsigned long i;

	for (i = 0; i < n; i++) {
		h = (h ^ p[i]) * 0x100000001b3ULL;
	}

	return (h);
}

/*
 * FNV-1a digest of RAM, CPU registers, clock counter and video.
 * Two identical runs must give the same value (16 hexadecimal digits).
 */
EMSCRIPTEN_KEEPALIVE
const char *pce_st_state_hash (void)
{
	unsigned      i;
	uint64_t      h;
	uint32_t      regs[19];
	unsigned long long clk;
	terminal_t    *trm;

	h = 0xcbf29ce484222325ULL;

	h = hash_bytes (h, mem_blk_get_data (par_sim->ram), mem_blk_get_size (par_sim->ram));

	for (i = 0; i < 8; i++) {
		regs[i] = (uint32_t) e68_get_dreg32 (par_sim->cpu, i);
		regs[8 + i] = (uint32_t) e68_get_areg32 (par_sim->cpu, i);
	}

	regs[16] = (uint32_t) e68_get_pc (par_sim->cpu);
	regs[17] = (uint32_t) e68_get_sr (par_sim->cpu);
	regs[18] = par_sim->video->frame;

	h = hash_bytes (h, (const unsigned char *) regs, sizeof (regs));

	clk = st_get_clkcnt (par_sim);
	h = hash_bytes (h, (const unsigned char *) &clk, sizeof (clk));

	trm = par_sim->trm;

	if (trm->buf != NULL) {
		h = hash_bytes (h, trm->buf, 3UL * trm->w * trm->h);
	}

	snprintf (hash_str, sizeof (hash_str), "%016llx", (unsigned long long) h);

	return (hash_str);
}
