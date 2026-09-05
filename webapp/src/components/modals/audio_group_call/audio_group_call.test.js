jest.mock('manifest', () => ({id: 'mattermost-webrtc-video'}), {virtual: true});
jest.mock('webrtc-swarm', () => jest.fn());
jest.mock('../../../utils/voiceRoomsApi', () => ({
    createVoiceRoom: jest.fn(),
    deleteVoiceRoom: jest.fn(),
    fetchVoiceRooms: jest.fn(),
    sendVoicePresence: jest.fn(),
}));

import {sendVoicePresence} from '../../../utils/voiceRoomsApi';

import {AudioCallPanel, SWARM_CLOSE_TIMEOUT_MS} from './audio_group_call';

function captureCleanupCallback(holder) {
    return (callback) => {
        holder.finish = callback;
    };
}

function throwCloseError() {
    throw new Error('close failed');
}

function leaveClosePending() {
    // Simulates a peer that never emits close.
}

describe('AudioCallPanel leaving a room', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('applies the refreshed directory after clearing presence', async () => {
        const rooms = [{roomId: 'room-1', participants: []}];
        sendVoicePresence.mockResolvedValue(rooms);

        const panel = Object.create(AudioCallPanel.prototype);
        panel.stopPresence = jest.fn();
        panel.applyRooms = jest.fn();

        await panel.clearPresence();

        expect(panel.stopPresence).toHaveBeenCalledTimes(1);
        expect(sendVoicePresence).toHaveBeenCalledWith('');
        expect(panel.applyRooms).toHaveBeenCalledWith(rooms);
    });

    test('updates local state without waiting for the swarm to close', () => {
        const cleanup = {};
        const done = jest.fn();
        const panel = {
            connectPending: true,
            isUnmounted: false,
            clearPresence: jest.fn(),
            cleanupConnection: jest.fn(captureCleanupCallback(cleanup)),
            setState: jest.fn(),
        };

        AudioCallPanel.prototype.leaveRoomInternal.call(panel, done);

        expect(panel.connectPending).toBe(false);
        expect(panel.clearPresence).toHaveBeenCalledTimes(1);
        expect(panel.setState).toHaveBeenCalledWith(expect.objectContaining({
            activeRoom: null,
            swarmInitialized: false,
            peerStreams: {},
        }));
        expect(done).not.toHaveBeenCalled();

        cleanup.finish();
        expect(done).toHaveBeenCalledTimes(1);
    });

    test('continues cleanup when closing the swarm throws', () => {
        const done = jest.fn();
        const panel = {
            state: {playBacks: {}},
            currentMyStream: null,
            swarmInstance: {close: jest.fn(throwCloseError)},
        };

        let thrownError = null;
        try {
            AudioCallPanel.prototype.cleanupConnection.call(panel, done);
        } catch (error) {
            thrownError = error;
        }

        expect(thrownError).toBeNull();
        expect(panel.swarmInstance).toBeNull();
        expect(done).toHaveBeenCalledTimes(1);
    });

    test('continues cleanup when the swarm omits its close callback', () => {
        jest.useFakeTimers();
        const done = jest.fn();
        const panel = {
            state: {playBacks: {}},
            currentMyStream: null,
            swarmInstance: {close: jest.fn(leaveClosePending)},
        };

        AudioCallPanel.prototype.cleanupConnection.call(panel, done);
        expect(done).not.toHaveBeenCalled();

        jest.advanceTimersByTime(SWARM_CLOSE_TIMEOUT_MS);
        expect(done).toHaveBeenCalledTimes(1);
    });
});
