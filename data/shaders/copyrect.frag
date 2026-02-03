#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 fTextureCoordinate;
layout(location = 0) out uint oColour;

uniform usampler2D uTexture;

void main()
{
    oColour = texture(uTexture, fTextureCoordinate).r;
}
