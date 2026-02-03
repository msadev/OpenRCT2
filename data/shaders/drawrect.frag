#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;
precision highp usampler2D;

// clang-format off
const int MASK_REMAP_COUNT          = 3;
const int FLAG_NO_TEXTURE           = (1 << 2);
const int FLAG_MASK                 = (1 << 3);
const int FLAG_CROSS_HATCH          = (1 << 4);
const int FLAG_TTF_TEXT             = (1 << 5);

uniform usampler2DArray uTexture;
uniform usampler2D      uPaletteTex;

uniform sampler2D       uPeelingTex;
uniform bool            uPeeling;

flat in int             fFlags;
flat in uint            fColour;
flat in vec4            fTexColour;
flat in vec4            fTexMask;
flat in vec3            fPalettes;

flat in vec2            fPosition;
in vec3                 fPeelPos;
flat in float           fZoom;
flat in int             fTexColourAtlas;
flat in int             fTexMaskAtlas;
flat in int             fScreenHeight;
// clang-format on

layout(location = 0) out uint oColour;

void main()
{
    if (uPeeling)
    {
        float peel = texture(uPeelingTex, fPeelPos.xy).r;
        if (peel == 0.0 || fPeelPos.z >= peel)
        {
            discard;
        }
    }

    vec2 fragCoord = vec2(floor(gl_FragCoord.x), float(fScreenHeight) - floor(gl_FragCoord.y) - 1.0);
    vec2 position = (fragCoord - fPosition) * fZoom;

    uint texel;
    if ((fFlags & FLAG_NO_TEXTURE) == 0)
    {
        float colourU = (fTexColour.x + position.x) / fTexColour.z;
        float colourV = (fTexColour.y + position.y) / fTexColour.w;
        texel = texture(uTexture, vec3(colourU, colourV, float(fTexColourAtlas))).r;
        if (texel == 0u)
        {
            discard;
        }
        if ((fFlags & FLAG_TTF_TEXT) == 0)
        {
            texel += fColour;
        }
        else
        {
            uint hint_thresh = uint(fFlags & 0xff00) >> 8;
            if (hint_thresh > 0u)
            {
                bool solidColor = texel > 180u;
                texel = (texel > hint_thresh) ? fColour : 0u;
                texel = texel << 8;
                if (solidColor)
                {
                    texel += 1u;
                }
            }
            else
            {
                texel = fColour;
            }
        }
    }
    else
    {
        texel = fColour;
    }

    int paletteCount = fFlags & MASK_REMAP_COUNT;
    if (paletteCount >= 3 && texel >= 0x2Eu && texel < 0x3Au)
    {
        texel = texture(uPaletteTex, vec2(float(texel + 0xC5u), fPalettes.z) / 256.0).r;
    }
    else if (paletteCount >= 2 && texel >= 0xCAu && texel < 0xD6u)
    {
        texel = texture(uPaletteTex, vec2(float(texel + 0x29u), fPalettes.y) / 256.0).r;
    }
    else if (paletteCount >= 1)
    {
        texel = texture(uPaletteTex, vec2(float(texel), fPalettes.x) / 256.0).r;
    }

    if (texel == 0u)
    {
        discard;
    }

    if ((fFlags & FLAG_CROSS_HATCH) != 0)
    {
        int posSum = int(position.x) + int(position.y);
        if ((posSum - (posSum / 2) * 2) != 0)
        {
            discard;
        }
    }

    if ((fFlags & FLAG_MASK) != 0)
    {
        float maskU = (fTexMask.x + position.x) / fTexMask.z;
        float maskV = (fTexMask.y + position.y) / fTexMask.w;
        uint mask = texture(uTexture, vec3(maskU, maskV, float(fTexMaskAtlas))).r;
        if (mask == 0u)
        {
            discard;
        }
    }

    oColour = texel;
}
