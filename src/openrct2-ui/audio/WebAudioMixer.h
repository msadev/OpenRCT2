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

#include "AudioFormat.h"

#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#include <openrct2/audio/AudioChannel.h>
#include <openrct2/audio/AudioMixer.h>

namespace OpenRCT2::Audio
{
    class WebAudioChannel;
    class SDLAudioSource;

    class WebAudioMixer final : public IAudioMixer
    {
    public:
        WebAudioMixer();
        ~WebAudioMixer() override;

        void Init(const char* device) override;
        void Close() override;
        void Lock() override;
        void Unlock() override;
        std::shared_ptr<IAudioChannel> Play(IAudioSource* source, int32_t loop, bool deleteondone) override;
        void SetVolume(float volume) override;

        void Tick();
        void OnChannelEnded(int32_t channelId);

        void UpdateChannel(WebAudioChannel& channel, bool restart);
        uint64_t GetChannelOffsetBytes(const WebAudioChannel& channel) const;
        SDLAudioSource* AddSource(std::unique_ptr<SDLAudioSource> source);

    private:
        void UpdateAdjustedSound();
        float GetAdjustedVolume(const WebAudioChannel& channel) const;
        void RegisterChannel(int32_t channelId, const std::shared_ptr<WebAudioChannel>& channel);
        std::shared_ptr<WebAudioChannel> FindChannel(int32_t channelId) const;
        void RemoveChannel(int32_t channelId);

        int32_t _nextChannelId = 1;
        float _volume = 1.0f;

        int32_t _settingSoundVolume = -1;
        int32_t _settingMusicVolume = -1;
        float _adjustSoundVolume = 1.0f;
        float _adjustMusicVolume = 1.0f;

        mutable std::mutex _mutex;
        std::list<std::shared_ptr<WebAudioChannel>> _channels;
        std::unordered_map<int32_t, std::weak_ptr<WebAudioChannel>> _channelMap;
        std::vector<std::unique_ptr<SDLAudioSource>> _sources;
    };
} // namespace OpenRCT2::Audio

#endif
