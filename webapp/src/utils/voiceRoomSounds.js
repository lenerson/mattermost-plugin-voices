import debug from './debug';

const QUIET_GAIN = 0.0001;
const PEAK_GAIN = 0.045;
const TONE_DURATION_SECONDS = 0.12;
const TONE_STEP_SECONDS = 0.14;
const ATTACK_SECONDS = 0.015;
const CLOSE_PADDING_SECONDS = 0.05;
const MILLISECONDS_PER_SECOND = 1000;

const JOIN_FREQUENCIES = [523.25, 659.25];
const LEAVE_FREQUENCIES = [659.25, 392.00];
const INVITE_FREQUENCIES = [659.25, 783.99, 987.77];

function closeContextLater(context, toneCount) {
    const sequenceSeconds = (toneCount * TONE_STEP_SECONDS) + CLOSE_PADDING_SECONDS;
    setTimeout(() => {
        try {
            if (context.state !== 'closed') {
                context.close();
            }
        } catch (error) {
            debug('closing voice room sound failed', error);
        }
    }, sequenceSeconds * MILLISECONDS_PER_SECOND);
}

function playSequence(frequencies) {
    if (typeof window === 'undefined') {
        return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
        return;
    }

    try {
        const context = new AudioContextCtor();
        if (context.state === 'suspended' && context.resume) {
            context.resume().catch(() => {
                /* Browser has not granted audio playback yet. */
            });
        }

        frequencies.forEach((frequency, index) => {
            const startsAt = context.currentTime + (index * TONE_STEP_SECONDS);
            const endsAt = startsAt + TONE_DURATION_SECONDS;
            const oscillator = context.createOscillator();
            const gain = context.createGain();

            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(QUIET_GAIN, startsAt);
            gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startsAt + ATTACK_SECONDS);
            gain.gain.exponentialRampToValueAtTime(QUIET_GAIN, endsAt);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(startsAt);
            oscillator.stop(endsAt);
        });

        closeContextLater(context, frequencies.length);
    } catch (error) {
        debug('playing voice room sound failed', error);
    }
}

export function playVoiceRoomJoinSound() {
    playSequence(JOIN_FREQUENCIES);
}

export function playVoiceRoomLeaveSound() {
    playSequence(LEAVE_FREQUENCIES);
}

export function playVoiceRoomInviteSound() {
    playSequence(INVITE_FREQUENCIES);
}
