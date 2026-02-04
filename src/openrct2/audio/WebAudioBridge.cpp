/*****************************************************************************
 * Copyright (c) 2014-2026 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef __EMSCRIPTEN__

#include "WebAudioBridge.h"

#include <emscripten/emscripten.h>

namespace OpenRCT2::Audio
{
    static WebAudioEndedCallback gWebAudioEndedCallback = nullptr;

    void SetWebAudioChannelEndedCallback(WebAudioEndedCallback callback)
    {
        gWebAudioEndedCallback = callback;
    }
} // namespace OpenRCT2::Audio

extern "C" EMSCRIPTEN_KEEPALIVE void WebAudioChannelEnded(int32_t channelId)
{
    if (OpenRCT2::Audio::gWebAudioEndedCallback != nullptr)
    {
        OpenRCT2::Audio::gWebAudioEndedCallback(channelId);
    }
}

#endif
