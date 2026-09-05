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

function hasAriaLabel(label) {
    return (element) => element.props && element.props['aria-label'] === label;
}

function hasClassName(className) {
    return (element) => element.props && element.props.className === className;
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
            speakerOn: true,
        }));
        expect(panel.startPresence).toHaveBeenCalledWith('room-1');
    });

    test('shows stable channel settings on hover and deletes from its popup menu', () => {
        const panel = new AudioCallPanel({
            userId: 'user-1',
            profilesById: {},
            isSystemAdmin: false,
        });
        panel.state.channelList = [{
            roomId: 'room-1',
            name: 'Standup',
            creatorId: 'user-1',
            participants: [],
        }];
        panel.setState = (update) => {
            const nextState = typeof update === 'function' ? update(panel.state) : update;
            panel.state = {...panel.state, ...nextState};
        };

        let rendered = panel.render();
        const roomRow = findElements(rendered, (element) => element.type === 'li' && element.props.onMouseEnter)[0];
        const initialRowStyle = roomRow.props.style;
        const hiddenSettingsButton = findElements(rendered, (element) => element.props && element.props['aria-label'] === 'Voice channel settings for Standup')[0];

        expect(hiddenSettingsButton.props.style.visibility).toBe('hidden');
        expect(hiddenSettingsButton.props.tabIndex).toBe(-1);

        roomRow.props.onMouseEnter();

        rendered = panel.render();
        const settingsButton = findElements(rendered, (element) => element.props && element.props['aria-label'] === 'Voice channel settings for Standup')[0];
        expect(settingsButton.props.style.visibility).toBeUndefined();
        expect(settingsButton.props.tabIndex).toBe(0);
        expect(findElements(rendered, (element) => element.type === 'li' && element.props.onMouseEnter)[0].props.style).toEqual(initialRowStyle);

        const settingsEvent = {preventDefault: jest.fn(), stopPropagation: jest.fn()};
        settingsButton.props.onClick(settingsEvent);

        expect(settingsEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(settingsEvent.stopPropagation).toHaveBeenCalledTimes(1);

        rendered = panel.render();
        expect(findElements(rendered, (element) => element.props && element.props.role === 'menu')).toHaveLength(1);
        expect(findElements(rendered, (element) => element.type === 'li' && element.props.onMouseEnter)[0].props.style).toEqual(initialRowStyle);
        expect(findElements(rendered, (element) => element.type === 'ul')[0].props.style.overflow).toBe('visible');

        const deleteHandler = jest.fn();
        panel.handleDeleteRoom = jest.fn(() => deleteHandler);
        const deleteItem = findElements(rendered, (element) => element.props && element.props.role === 'menuitem')[0];
        expect(deleteItem.props.style.color).toBe('#ffb4b4');
        const deleteEvent = {};
        deleteItem.props.onClick(deleteEvent);

        expect(panel.handleDeleteRoom).toHaveBeenCalledWith('room-1');
        expect(deleteHandler).toHaveBeenCalledWith(deleteEvent);
        expect(panel.state.openRoomMenuId).toBeNull();
    });
});

describe('AudioCallPanel speaker control', () => {
    test('starts enabled and uses a slashed loudspeaker only while disabled', () => {
        const panel = new AudioCallPanel({
            userId: 'user-1',
            profilesById: {},
            isSystemAdmin: false,
        });

        expect(panel.state.speakerOn).toBe(true);

        panel.state.activeRoom = {roomId: 'room-1', name: 'Standup'};
        panel.state.speakerOn = false;
        let rendered = panel.render();
        const disabledControl = findElements(rendered, hasAriaLabel('Enable voice channel audio'))[0];

        expect(findElements(disabledControl, hasClassName('icon fa fa-volume-up fa-lg'))).toHaveLength(1);
        expect(findElements(disabledControl, hasClassName('voice-channel-speaker-slash'))).toHaveLength(1);

        panel.state.speakerOn = true;
        rendered = panel.render();
        const enabledControl = findElements(rendered, hasAriaLabel('Disable voice channel audio'))[0];

        expect(findElements(enabledControl, hasClassName('icon fa fa-volume-up fa-lg'))).toHaveLength(1);
        expect(findElements(enabledControl, hasClassName('voice-channel-speaker-slash'))).toHaveLength(0);
    });

    test('mutes existing remote playbacks when disabled', () => {
        const playback = {muted: false};
        const panel = {
            state: {
                playBacks: {peer: playback},
                speakerOn: true,
            },
            setState: jest.fn(),
        };

        AudioCallPanel.prototype.handleSpeakerToggle.call(panel);

        expect(playback.muted).toBe(true);
        expect(panel.setState).toHaveBeenCalledWith({speakerOn: false});
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
