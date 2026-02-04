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

    const MAX_STREAM_FRAMES = 22050 * 10; // 10 seconds at 22050 Hz

    function buildBuffer(ctx, channelCount, frames, sampleRate, interleaved, interleavedOffset) {
        const buffer = ctx.createBuffer(channelCount, frames, sampleRate);
        if (channelCount === 1) {
            buffer.getChannelData(0).set(interleaved.subarray(interleavedOffset, interleavedOffset + frames));
            return buffer;
        }
        for (let c = 0; c < channelCount; c++) {
            const channelData = buffer.getChannelData(c);
            for (let i = 0, idx = interleavedOffset + c; i < frames; i++, idx += channelCount) {
                channelData[i] = interleaved[idx];
            }
        }
        return buffer;
    }

    function scheduleChunk(entry) {
        const { ctx } = Module.WebAudio;
        const framesRemaining = entry.framesTotal - entry.cursorFrame;
        if (framesRemaining <= 0) {
            if (entry.loop) {
                entry.cursorFrame = 0;
            } else {
                entry.onFullyEnded();
                return;
            }
        }
        const frames = Math.min(MAX_STREAM_FRAMES, entry.framesTotal - entry.cursorFrame);
        if (frames <= 0) {
            entry.onFullyEnded();
            return;
        }
        let buffer;
        try {
            buffer = buildBuffer(
                ctx,
                entry.channelCount,
                frames,
                entry.sampleRate,
                entry.data,
                entry.cursorFrame * entry.channelCount
            );
        } catch (e) {
            console.warn('WebAudio stream: createBuffer failed', e);
            entry.onFullyEnded();
            return;
        }

        let source;
        try {
            source = ctx.createBufferSource();
        } catch (e) {
            console.warn('WebAudio stream: createBufferSource failed', e);
            entry.onFullyEnded();
            return;
        }
        source.buffer = buffer;
        source.loop = false;
        source.playbackRate.value = entry.rate;

        if (entry.panner) {
            source.connect(entry.panner);
        } else {
            source.connect(entry.gain);
        }

        entry.source = source;
        entry.startTime = ctx.currentTime;
        entry.offsetSec = entry.cursorFrame / entry.sampleRate;
        entry.cursorFrame += frames;

        source.onended = () => {
            scheduleChunk(entry);
        };

        try {
            source.start(0);
        } catch (e) {
            console.warn('WebAudio stream: start failed', e);
            entry.onFullyEnded();
        }
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
            if (!ctx || ctx.state === 'closed') return;
            if (!Number.isFinite(channelCount) || !Number.isFinite(frames) || channelCount <= 0 || frames <= 0) return;
            if (channelCount > 2) return;
            const totalSamples = frames * channelCount;
            if (!Number.isFinite(totalSamples) || totalSamples <= 0) return;

            let interleaved;
            try {
                const start = dataPtr >> 2;
                interleaved = Module.HEAPF32.subarray(start, start + totalSamples);
            } catch (e) {
                console.warn('WebAudio playChannel: invalid audio buffer', e);
                return;
            }
            if (!interleaved || interleaved.length < totalSamples) return;

            if (frames > MAX_STREAM_FRAMES) {
                const dataCopy = new Float32Array(totalSamples);
                dataCopy.set(interleaved);

                const gain = ctx.createGain();
                gain.gain.value = 0;
                let panner = null;
                if (ctx.createStereoPanner) {
                    panner = ctx.createStereoPanner();
                    panner.pan.value = (pan * 2.0) - 1.0;
                    panner.connect(gain);
                }
                gain.connect(ctx.destination);
                Module.WebAudio._setGain(gain, volume);
                if (panner) {
                    Module.WebAudio._setPan(panner, (pan * 2.0) - 1.0);
                }

                const startFrame = Math.max(0, Math.min(frames - 1, Math.floor(offsetSeconds * sampleRate)));
                const entry = {
                    source: null,
                    gain,
                    panner,
                    data: dataCopy,
                    channelCount,
                    framesTotal: frames,
                    sampleRate,
                    cursorFrame: startFrame,
                    loop: loop !== 0,
                    rate,
                    startTime: ctx.currentTime,
                    offsetSec: offsetSeconds,
                    onFullyEnded: () => {
                        channels.delete(channelId);
                        try {
                            if (Module.ccall) {
                                Module.ccall('WebAudioChannelEnded', 'void', ['number'], [channelId]);
                            }
                        } catch (e) {}
                    }
                };
                channels.set(channelId, entry);
                scheduleChunk(entry);
                return;
            }

            let buffer;
            try {
                buffer = buildBuffer(ctx, channelCount, frames, sampleRate, interleaved, 0);
            } catch (e) {
                console.warn('WebAudio playChannel: createBuffer failed', e);
                return;
            }

            let source;
            try {
                source = ctx.createBufferSource();
            } catch (e) {
                console.warn('WebAudio playChannel: createBufferSource failed', e);
                return;
            }
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
            } catch (e) {
                console.warn('WebAudio playChannel: start failed', e);
            }
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
                if (entry.data) {
                    const startFrame = Math.max(
                        0,
                        Math.min(entry.framesTotal - 1, Math.floor(offsetSeconds * entry.sampleRate))
                    );
                    entry.cursorFrame = startFrame;
                    entry.startTime = ctx.currentTime;
                    entry.offsetSec = offsetSeconds;
                    scheduleChunk(entry);
                    return;
                }
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
            if (entry.data && entry.framesTotal && entry.sampleRate) {
                return entry.cursorFrame / entry.sampleRate;
            }
            const rate = entry.rate || 1.0;
            const startTime = entry.startTime || 0.0;
            const offset = entry.offsetSec || 0.0;
            const elapsed = Math.max(0.0, ctx.currentTime - startTime);
            return offset + (elapsed * rate);
        }
    };
}
