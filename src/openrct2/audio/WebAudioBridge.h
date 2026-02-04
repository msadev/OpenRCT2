/*****************************************************************************
 * Copyright (c) 2014-2026 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#pragma once

#ifdef __EMSCRIPTEN__

#include <cstdint>

namespace OpenRCT2::Audio
{
    using WebAudioEndedCallback = void (*)(int32_t);

    void SetWebAudioChannelEndedCallback(WebAudioEndedCallback callback);

} // namespace OpenRCT2::Audio

extern "C" void WebAudioChannelEnded(int32_t channelId);

#endif
