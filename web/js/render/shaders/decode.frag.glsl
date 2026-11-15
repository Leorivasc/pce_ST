#version 300 es
precision mediump float;
uniform sampler2D u_rgbTex;
in vec2 v_uv;
out vec4 outColor;
void main(){
  outColor = vec4(texture(u_rgbTex, v_uv).rgb, 1.0);
}
