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

function findElements(node, predicate, matches = []) {
    if (Array.isArray(node)) {
        node.forEach((child) => findElements(child, predicate, matches));
        return matches;
    }
    if (!node || typeof node !== 'object') {
        return matches;
    }
    if (predicate(node)) {
        matches.push(node);
    }

    const children = node.props && node.props.children;
    findElements(children, predicate, matches);

    return matches;
}

describe('AudioCallPanel room directory', () => {
    test('joins when the room name row is selected without rendering a separate Join button', () => {
        const panel = new AudioCallPanel({
            userId: 'user-1',
            profilesById: {},
            isSystemAdmin: false,
        });
        panel.state.channelList = [{roomId: 'room-1', name: 'Standup', participants: []}];
        panel.cleanupConnection = (callback) => callback();
        panel.setState = jest.fn();
        panel.startPresence = jest.fn();

        const buttons = findElements(panel.render(), (element) => element.type === 'button');

        expect(buttons).toHaveLength(1);
        expect(buttons[0].props['aria-label']).toBe('Join voice channel Standup');

        const event = {preventDefault: jest.fn()};
        buttons[0].props.onClick(event);

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(panel.setState).toHaveBeenCalledWith(expect.objectContaining({
            activeRoom: {roomId: 'room-1', name: 'Standup'},
            audioOn: true,
        }));
        expect(panel.startPresence).toHaveBeenCalledWith('room-1');
    });
});

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
