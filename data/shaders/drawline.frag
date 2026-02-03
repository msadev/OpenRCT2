#version 300 es
precision highp float;
precision highp int;

flat in uint fColour;

layout(location = 0) out uint oColour;

void main()
{
    oColour = fColour;
}
