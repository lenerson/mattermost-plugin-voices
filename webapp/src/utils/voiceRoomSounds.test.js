import {playVoiceRoomInviteSound, playVoiceRoomJoinSound, playVoiceRoomLeaveSound} from './voiceRoomSounds';

const contexts = [];

class FakeAudioContext {
    constructor() {
        this.currentTime = 1;
        this.destination = {};
        this.state = 'running';
        this.oscillators = [];
        this.close = jest.fn(() => {
            this.state = 'closed';
        });
        contexts.push(this);
    }

    createOscillator() {
        const oscillator = {
            frequency: {value: 0},
            connect: jest.fn(),
            start: jest.fn(),
            stop: jest.fn(),
        };
        this.oscillators.push(oscillator);
        return oscillator;
    }

    createGain() {
        return {
            gain: {
                setValueAtTime: jest.fn(),
                exponentialRampToValueAtTime: jest.fn(),
            },
            connect: jest.fn(),
        };
    }
}

function oscillatorFrequencies(context) {
    return context.oscillators.map((oscillator) => oscillator.frequency.value);
}

describe('voiceRoomSounds', () => {
    beforeEach(() => {
        contexts.length = 0;
        global.window = {AudioContext: FakeAudioContext};
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        delete global.window;
    });

    test('uses an ascending pair of tones for joining', () => {
        playVoiceRoomJoinSound();

        expect(contexts).toHaveLength(1);
        expect(oscillatorFrequencies(contexts[0])).toEqual([523.25, 659.25]);
    });

    test('uses a descending pair of tones for leaving', () => {
        playVoiceRoomLeaveSound();

        expect(contexts).toHaveLength(1);
        expect(oscillatorFrequencies(contexts[0])).toEqual([659.25, 392.00]);
    });

    test('uses a distinct ascending chime for an invitation', () => {
        playVoiceRoomInviteSound();

        expect(contexts).toHaveLength(1);
        expect(oscillatorFrequencies(contexts[0])).toEqual([659.25, 783.99, 987.77]);
    });
});
