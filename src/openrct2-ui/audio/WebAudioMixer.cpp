/*****************************************************************************
 * Copyright (c) 2014-2026 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef __EMSCRIPTEN__

#include "WebAudioMixer.h"

#include "SDLAudioSource.h"

#include <SDL.h>
#include <algorithm>
#include <cmath>
#include <emscripten.h>
#include <mutex>
#include <openrct2/OpenRCT2.h>
#include <openrct2/audio/WebAudioBridge.h>
#include <openrct2/config/Config.h>
#include <unordered_map>

using namespace OpenRCT2::Audio;

extern "C" {
void WebAudioEnsureInit();
void WebAudioStopChannel(int32_t channelId);
void WebAudioPlayChannel(
    int32_t channelId, int32_t channels, int32_t frames, int32_t sampleRate, const float* data, int32_t loop,
    double rate, double volume, double pan, double offsetSeconds);
void WebAudioUpdateChannel(int32_t channelId, double rate, double volume, double pan, double offsetSeconds, int restart);
double WebAudioGetOffsetSeconds(int32_t channelId);
}

namespace
{
    WebAudioMixer* g_WebAudioMixer = nullptr;

    static std::vector<uint8_t> ReadAllPcmData(IAudioSource* source)
    {
        const uint64_t length = source->GetLength();
        std::vector<uint8_t> data;
        data.resize(static_cast<size_t>(length));
        if (length > 0)
        {
            source->Read(data.data(), 0, static_cast<size_t>(length));
        }
        return data;
    }

    static bool ConvertToS16(AudioFormat& format, std::vector<uint8_t>& data)
    {
        if (format.format == AUDIO_S16SYS)
        {
            return true;
        }

        SDL_AudioCVT cvt;
        if (SDL_BuildAudioCVT(&cvt, format.format, format.channels, format.freq, AUDIO_S16SYS, format.channels, format.freq) < 0)
        {
            return false;
        }
        const size_t srcLen = data.size();
        std::vector<uint8_t> buffer(srcLen * cvt.len_mult);
        std::copy_n(data.data(), srcLen, buffer.data());
        cvt.len = static_cast<int32_t>(srcLen);
        cvt.buf = buffer.data();
        if (SDL_ConvertAudio(&cvt) < 0)
        {
            return false;
        }
        buffer.resize(cvt.len_cvt);
        data = std::move(buffer);
        format.format = AUDIO_S16SYS;
        return true;
    }

    static std::vector<float> ConvertToFloat(const AudioFormat& format, const std::vector<uint8_t>& data)
    {
        std::vector<float> samples;
        if (format.format == AUDIO_U8)
        {
            samples.resize(data.size());
            for (size_t i = 0; i < data.size(); i++)
            {
                samples[i] = (static_cast<int32_t>(data[i]) - 128) / 128.0f;
            }
            return samples;
        }

        const size_t sampleCount = data.size() / sizeof(int16_t);
        samples.resize(sampleCount);
        auto* pcm = reinterpret_cast<const int16_t*>(data.data());
        for (size_t i = 0; i < sampleCount; i++)
        {
            samples[i] = static_cast<float>(pcm[i]) / 32768.0f;
        }
        return samples;
    }
} // namespace

namespace OpenRCT2::Audio
{
    class WebAudioChannel final : public IAudioChannel
    {
    public:
        WebAudioChannel(WebAudioMixer& mixer, int32_t channelId)
            : _mixer(mixer)
            , _channelId(channelId)
        {
            SetRate(1);
            SetVolume(kMixerVolumeMax);
            SetPan(0.5f);
        }

        [[nodiscard]] IAudioSource* GetSource() const override
        {
            return _source;
        }

        [[nodiscard]] MixerGroup GetGroup() const override
        {
            return _group;
        }

        void SetGroup(MixerGroup group) override
        {
            _group = group;
            _mixer.UpdateChannel(*this, false);
        }

        [[nodiscard]] double GetRate() const override
        {
            return _rate;
        }

        void SetRate(double rate) override
        {
            _rate = std::max(0.001, rate);
            _mixer.UpdateChannel(*this, false);
        }

        [[nodiscard]] uint64_t GetOffset() const override
        {
            return _mixer.GetChannelOffsetBytes(*this);
        }

        bool SetOffset(uint64_t offset) override
        {
            if (_format.GetBytesPerSecond() == 0)
            {
                return false;
            }
            _offsetBytes = offset;
            _mixer.UpdateChannel(*this, true);
            return true;
        }

        [[nodiscard]] int32_t GetLoop() const override
        {
            return _loop;
        }

        void SetLoop(int32_t value) override
        {
            _loop = value;
        }

        [[nodiscard]] int32_t GetVolume() const override
        {
            return _volume;
        }

        [[nodiscard]] float GetVolumeL() const override
        {
            return _volume_l;
        }

        [[nodiscard]] float GetVolumeR() const override
        {
            return _volume_r;
        }

        [[nodiscard]] float GetOldVolumeL() const override
        {
            return _oldvolume_l;
        }

        [[nodiscard]] float GetOldVolumeR() const override
        {
            return _oldvolume_r;
        }

        [[nodiscard]] int32_t GetOldVolume() const override
        {
            return _oldvolume;
        }

        void SetVolume(int32_t volume) override
        {
            _volume = std::clamp(volume, 0, kMixerVolumeMax);
            _mixer.UpdateChannel(*this, false);
        }

        [[nodiscard]] float GetPan() const override
        {
            return _pan;
        }

        void SetPan(float pan) override
        {
            _pan = std::clamp(pan, 0.0f, 1.0f);
            double decibels = (std::abs(_pan - 0.5) * 2.0) * 100.0;
            double attenuation = pow(10, decibels / 20.0);
            if (_pan <= 0.5)
            {
                _volume_l = 1.0;
                _volume_r = static_cast<float>(1.0 / attenuation);
            }
            else
            {
                _volume_r = 1.0;
                _volume_l = static_cast<float>(1.0 / attenuation);
            }
            _mixer.UpdateChannel(*this, false);
        }

        [[nodiscard]] bool IsStopping() const override
        {
            return _stopping;
        }

        void SetStopping(bool value) override
        {
            _stopping = value;
        }

        [[nodiscard]] bool IsDone() const override
        {
            return _done;
        }

        void SetDone(bool value) override
        {
            _done = value;
        }

        [[nodiscard]] bool DeleteOnDone() const override
        {
            return _deleteondone;
        }

        void SetDeleteOnDone(bool value) override
        {
            _deleteondone = value;
        }

        [[nodiscard]] bool IsPlaying() const override
        {
            return !_done;
        }

        void Play(IAudioSource* source, int32_t loop) override
        {
            _source = source;
            _loop = loop;
            _offsetBytes = 0;
            _done = false;
        }

        void Stop() override
        {
            SetStopping(true);
        }

        void UpdateOldVolume() override
        {
            _oldvolume = _volume;
            _oldvolume_l = _volume_l;
            _oldvolume_r = _volume_r;
        }

        size_t Read(void* dst, size_t len) override
        {
            (void)dst;
            (void)len;
            return 0;
        }

        int32_t GetChannelId() const
        {
            return _channelId;
        }

        const AudioFormat& GetFormat() const
        {
            return _format;
        }

        void SetFormat(const AudioFormat& format)
        {
            _format = format;
        }

        uint64_t GetOffsetBytes() const
        {
            return _offsetBytes;
        }

    private:
        WebAudioMixer& _mixer;
        int32_t _channelId = 0;

        IAudioSource* _source = nullptr;
        AudioFormat _format{};
        uint64_t _offsetBytes = 0;

        MixerGroup _group = MixerGroup::Sound;
        double _rate = 0;
        int32_t _loop = 0;

        int32_t _volume = 1;
        float _volume_l = 0.f;
        float _volume_r = 0.f;
        float _oldvolume_l = 0.f;
        float _oldvolume_r = 0.f;
        int32_t _oldvolume = 0;
        float _pan = 0;

        bool _stopping = false;
        bool _done = true;
        bool _deleteondone = false;
    };

    WebAudioMixer::WebAudioMixer()
    {
        g_WebAudioMixer = this;
        WebAudioEnsureInit();
        SetWebAudioChannelEndedCallback([](int32_t channelId) {
            if (g_WebAudioMixer != nullptr)
            {
                g_WebAudioMixer->OnChannelEnded(channelId);
            }
        });
    }

    WebAudioMixer::~WebAudioMixer()
    {
        Close();
        SetWebAudioChannelEndedCallback(nullptr);
        if (g_WebAudioMixer == this)
        {
            g_WebAudioMixer = nullptr;
        }
    }

    void WebAudioMixer::Init(const char* device)
    {
        (void)device;
        WebAudioEnsureInit();
    }

    void WebAudioMixer::Close()
    {
        std::lock_guard<std::mutex> guard(_mutex);
        for (auto& channel : _channels)
        {
            WebAudioStopChannel(channel->GetChannelId());
        }
        _channels.clear();
        _channelMap.clear();
        _sources.clear();
    }

    void WebAudioMixer::Lock()
    {
    }

    void WebAudioMixer::Unlock()
    {
    }

    std::shared_ptr<IAudioChannel> WebAudioMixer::Play(IAudioSource* source, int32_t loop, bool deleteondone)
    {
        if (source == nullptr)
        {
            return nullptr;
        }

        auto* sdlSource = dynamic_cast<SDLAudioSource*>(source);
        if (sdlSource == nullptr)
        {
            return nullptr;
        }

        AudioFormat format = sdlSource->GetFormat();
        auto pcmData = ReadAllPcmData(sdlSource);

        if (format.format != AUDIO_S16SYS && format.format != AUDIO_U8)
        {
            if (!ConvertToS16(format, pcmData))
            {
                return nullptr;
            }
        }

        auto floatData = ConvertToFloat(format, pcmData);
        const int32_t channels = format.channels;
        if (channels <= 0)
        {
            return nullptr;
        }
        const int32_t frames = static_cast<int32_t>(floatData.size() / channels);
        if (frames <= 0)
        {
            return nullptr;
        }

        std::lock_guard<std::mutex> guard(_mutex);
        const int32_t channelId = _nextChannelId++;
        auto channel = std::make_shared<WebAudioChannel>(*this, channelId);
        channel->SetFormat(format);
        channel->Play(source, loop);
        channel->SetDeleteOnDone(deleteondone);
        _channels.push_back(channel);
        RegisterChannel(channelId, channel);

        UpdateAdjustedSound();
        const float adjustedVolume = GetAdjustedVolume(*channel);
        const double offsetSeconds = static_cast<double>(channel->GetOffsetBytes()) / format.GetBytesPerSecond();

        WebAudioPlayChannel(
            channelId, channels, frames, format.freq, floatData.data(), loop, channel->GetRate(), adjustedVolume, channel->GetPan(),
            offsetSeconds);

        return channel;
    }

    void WebAudioMixer::SetVolume(float volume)
    {
        _volume = volume;
        Tick();
    }

    void WebAudioMixer::Tick()
    {
        UpdateAdjustedSound();
        std::lock_guard<std::mutex> guard(_mutex);
        for (auto it = _channels.begin(); it != _channels.end();)
        {
            auto& channel = *it;
            if (channel->IsStopping())
            {
                WebAudioStopChannel(channel->GetChannelId());
                channel->SetDone(true);
                RemoveChannel(channel->GetChannelId());
                it = _channels.erase(it);
                continue;
            }
            if (!channel->IsDone())
            {
                UpdateChannel(*channel, false);
            }
            ++it;
        }

        _sources.erase(
            std::remove_if(
                _sources.begin(), _sources.end(),
                [](std::unique_ptr<SDLAudioSource>& source) { return source->IsReleased(); }),
            _sources.end());
    }

    void WebAudioMixer::OnChannelEnded(int32_t channelId)
    {
        std::lock_guard<std::mutex> guard(_mutex);
        auto channel = FindChannel(channelId);
        if (channel != nullptr)
        {
            channel->SetDone(true);
            _channels.remove_if([channelId](const std::shared_ptr<WebAudioChannel>& entry) {
                return entry->GetChannelId() == channelId;
            });
            RemoveChannel(channelId);
        }
    }

    void WebAudioMixer::UpdateChannel(WebAudioChannel& channel, bool restart)
    {
        if (channel.IsDone())
        {
            return;
        }

        UpdateAdjustedSound();
        const float adjustedVolume = GetAdjustedVolume(channel);
        const auto bytesPerSecond = channel.GetFormat().GetBytesPerSecond();
        const double offsetSeconds = bytesPerSecond > 0 ? static_cast<double>(channel.GetOffsetBytes()) / bytesPerSecond : 0.0;
        WebAudioUpdateChannel(
            channel.GetChannelId(), channel.GetRate(), adjustedVolume, channel.GetPan(), offsetSeconds, restart ? 1 : 0);
    }

    uint64_t WebAudioMixer::GetChannelOffsetBytes(const WebAudioChannel& channel) const
    {
        const auto bytesPerSecond = channel.GetFormat().GetBytesPerSecond();
        if (bytesPerSecond == 0)
        {
            return 0;
        }
        const double seconds = WebAudioGetOffsetSeconds(channel.GetChannelId());
        return static_cast<uint64_t>(seconds * bytesPerSecond);
    }

    void WebAudioMixer::UpdateAdjustedSound()
    {
        if (_settingSoundVolume != Config::Get().sound.soundVolume)
        {
            _settingSoundVolume = Config::Get().sound.soundVolume;
            _adjustSoundVolume = powf(static_cast<float>(_settingSoundVolume) / 100.f, 10.f / 6.f);
        }
        if (_settingMusicVolume != Config::Get().sound.rideMusicVolume)
        {
            _settingMusicVolume = Config::Get().sound.rideMusicVolume;
            _adjustMusicVolume = powf(static_cast<float>(_settingMusicVolume) / 100.f, 10.f / 6.f);
        }
    }

    float WebAudioMixer::GetAdjustedVolume(const WebAudioChannel& channel) const
    {
        float volumeAdjust = _volume;
        volumeAdjust *= Config::Get().sound.masterSoundEnabled ? (static_cast<float>(Config::Get().sound.masterVolume) / 100.0f)
                                                               : 0.0f;

        switch (channel.GetGroup())
        {
            case MixerGroup::Sound:
                volumeAdjust *= _adjustSoundVolume;
                if (gLegacyScene == LegacyScene::titleSequence)
                {
                    volumeAdjust = std::min(volumeAdjust, 0.75f);
                }
                break;
            case MixerGroup::RideMusic:
            case MixerGroup::TitleMusic:
                volumeAdjust *= _adjustMusicVolume;
                break;
        }

        return (channel.GetVolume() * volumeAdjust) / static_cast<float>(kMixerVolumeMax);
    }

    void WebAudioMixer::RegisterChannel(int32_t channelId, const std::shared_ptr<WebAudioChannel>& channel)
    {
        _channelMap[channelId] = channel;
    }

    std::shared_ptr<WebAudioChannel> WebAudioMixer::FindChannel(int32_t channelId) const
    {
        auto it = _channelMap.find(channelId);
        if (it == _channelMap.end())
        {
            return nullptr;
        }
        return it->second.lock();
    }

    void WebAudioMixer::RemoveChannel(int32_t channelId)
    {
        _channelMap.erase(channelId);
    }

    SDLAudioSource* WebAudioMixer::AddSource(std::unique_ptr<SDLAudioSource> source)
    {
        std::lock_guard<std::mutex> guard(_mutex);
        if (source != nullptr)
        {
            _sources.push_back(std::move(source));
            return _sources.back().get();
        }
        return nullptr;
    }
} // namespace OpenRCT2::Audio

#endif
