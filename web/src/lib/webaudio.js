export function installWebAudio(Module) {
    if (!Module) return;
    if (Module.WebAudio) return;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const ctx = AudioContextCtor ? new AudioContextCtor() : null;
    const channels = new Map();

    const resume = () => {
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
    };
    if (ctx) {
        document.addEventListener('click', resume, { once: true });
        document.addEventListener('touchstart', resume, { once: true });
    }

    Module.WebAudio = {
        ctx,
        channels,
        _setGain(gainNode, value) {
            if (!ctx || !gainNode) return;
            const now = ctx.currentTime;
            try {
                gainNode.gain.cancelScheduledValues(now);
            } catch (e) {}
            try {
                gainNode.gain.setTargetAtTime(value, now, 0.02);
            } catch (e) {
                gainNode.gain.value = value;
            }
        },
        _setPan(pannerNode, value) {
            if (!ctx || !pannerNode) return;
            const now = ctx.currentTime;
            try {
                pannerNode.pan.cancelScheduledValues(now);
            } catch (e) {}
            try {
                pannerNode.pan.setTargetAtTime(value, now, 0.02);
            } catch (e) {
                pannerNode.pan.value = value;
            }
        },
        stopChannel(channelId) {
            const entry = channels.get(channelId);
            if (!entry) return;
            try { entry.source.onended = null; } catch (e) {}
            try { entry.source.stop(); } catch (e) {}
            try { entry.source.disconnect(); } catch (e) {}
            try { entry.gain.disconnect(); } catch (e) {}
            if (entry.panner) {
                try { entry.panner.disconnect(); } catch (e) {}
            }
            channels.delete(channelId);
        },
        playChannel(channelId, channelCount, frames, sampleRate, dataPtr, loop, rate, volume, pan, offsetSeconds) {
            if (!ctx) return;
            const totalSamples = frames * channelCount;
            const interleaved = Module.HEAPF32.subarray(dataPtr >> 2, (dataPtr >> 2) + totalSamples);

            const buffer = ctx.createBuffer(channelCount, frames, sampleRate);
            if (channelCount === 1) {
                buffer.getChannelData(0).set(interleaved);
            } else {
                for (let c = 0; c < channelCount; c++) {
                    const channelData = buffer.getChannelData(c);
                    for (let i = 0, idx = c; i < frames; i++, idx += channelCount) {
                        channelData[i] = interleaved[idx];
                    }
                }
            }

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.loop = loop !== 0;
            source.playbackRate.value = rate;

            const gain = ctx.createGain();
            gain.gain.value = 0;

            let panner = null;
            if (ctx.createStereoPanner) {
                panner = ctx.createStereoPanner();
                panner.pan.value = (pan * 2.0) - 1.0;
                source.connect(panner);
                panner.connect(gain);
            } else {
                source.connect(gain);
            }
            gain.connect(ctx.destination);
            Module.WebAudio._setGain(gain, volume);

            channels.set(channelId, {
                source,
                gain,
                panner,
                startTime: ctx.currentTime,
                offsetSec: offsetSeconds,
                rate
            });

            source.onended = () => {
                try {
                    if (Module.ccall) {
                        Module.ccall('WebAudioChannelEnded', 'void', ['number'], [channelId]);
                    }
                } catch (e) {}
                channels.delete(channelId);
            };

            try {
                source.start(0, offsetSeconds);
            } catch (e) {}
        },
        updateChannel(channelId, rate, volume, pan, offsetSeconds, restart) {
            if (!ctx) return;
            const entry = channels.get(channelId);
            if (!entry) return;

            Module.WebAudio._setGain(entry.gain, volume);
            entry.rate = rate;
            if (entry.source && entry.source.playbackRate) {
                entry.source.playbackRate.value = rate;
            }
            if (entry.panner) {
                Module.WebAudio._setPan(entry.panner, (pan * 2.0) - 1.0);
            }

            if (restart) {
                try { entry.source.stop(); } catch (e) {}
                const source = ctx.createBufferSource();
                source.buffer = entry.source.buffer;
                source.loop = entry.source.loop;
                source.playbackRate.value = rate;
                source.onended = entry.source.onended;

                if (entry.panner) {
                    source.connect(entry.panner);
                } else {
                    source.connect(entry.gain);
                }

                entry.source = source;
                entry.startTime = ctx.currentTime;
                entry.offsetSec = offsetSeconds;
                Module.WebAudio._setGain(entry.gain, volume);
                if (entry.panner) {
                    Module.WebAudio._setPan(entry.panner, (pan * 2.0) - 1.0);
                }
                try {
                    source.start(0, offsetSeconds);
                } catch (e) {}
            }
        },
        getOffsetSeconds(channelId) {
            if (!ctx) return 0;
            const entry = channels.get(channelId);
            if (!entry) return 0;
            const rate = entry.rate || 1.0;
            const startTime = entry.startTime || 0.0;
            const offset = entry.offsetSec || 0.0;
            const elapsed = Math.max(0.0, ctx.currentTime - startTime);
            return offset + (elapsed * rate);
        }
    };
}
