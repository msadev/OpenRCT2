#version 300 es
precision highp float;
precision highp usampler2D;

uniform vec4 uPalette[256];
uniform usampler2D uTexture;

in vec2 fTextureCoordinate;

layout(location = 0) out vec4 oColour;

void main()
{
    oColour = uPalette[texture(uTexture, fTextureCoordinate).r];
}
