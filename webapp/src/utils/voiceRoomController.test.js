import VoiceRoomController from './voiceRoomController';

describe('VoiceRoomController', () => {
    test('refreshes the directory and maintains presence heartbeats', async () => {
        const rooms = [{roomId: 'room-1'}];
        const onRooms = jest.fn();
        const interval = jest.fn(() => 'timer-1');
        const controller = new VoiceRoomController({
            fetchRooms: jest.fn(() => Promise.resolve(rooms)),
            sendPresence: jest.fn(() => Promise.resolve(rooms)),
            onRooms,
            onError: jest.fn(),
            setIntervalFn: interval,
            clearIntervalFn: jest.fn(),
        });

        await controller.refresh();
        controller.startPresence('room-1', () => true, 15000);

        expect(onRooms).toHaveBeenCalledWith(rooms);
        expect(controller.sendPresence).toHaveBeenCalledWith('room-1', true);
        expect(interval).toHaveBeenCalledWith(expect.any(Function), 15000);
    });

    test('reports failed directory and presence requests without throwing', async () => {
        const error = new Error('network unavailable');
        const onError = jest.fn();
        const controller = new VoiceRoomController({
            fetchRooms: jest.fn(() => Promise.reject(error)),
            sendPresence: jest.fn(() => Promise.reject(error)),
            onRooms: jest.fn(),
            onError,
        });

        await controller.refresh();
        await controller.clearPresence();

        expect(onError).toHaveBeenCalledWith('Could not load the voice channels.', error);
        expect(onError).toHaveBeenCalledWith('Could not update voice presence.', error);
    });
});
