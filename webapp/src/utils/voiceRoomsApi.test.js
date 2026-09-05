import {createVoiceRoom, deleteVoiceRoom, fetchVoiceRooms, sendVoicePresence} from './voiceRoomsApi';
import {mattermostApiRequest} from './mattermostApi';

jest.mock('./mattermostApi', () => ({
    mattermostApiRequest: jest.fn(),
}));

const roomsUrl = '/plugins/mattermost-webrtc-video/v1/voice/rooms';

describe('voiceRoomsApi', () => {
    beforeEach(() => {
        mattermostApiRequest.mockReset();
    });

    test('fetch returns the directory', async () => {
        const rooms = [{roomId: 'r1', name: 'Standup', creatorId: 'u1'}];
        mattermostApiRequest.mockResolvedValue({data: {rooms}});

        await expect(fetchVoiceRooms()).resolves.toEqual(rooms);
        expect(mattermostApiRequest).toHaveBeenCalledWith({
            method: 'get',
            url: roomsUrl,
        });
    });

    // The panel maps straight over the result, so a malformed body must not
    // reach it as undefined.
    test.each([
        ['no data', {}],
        ['no rooms key', {data: {}}],
        ['rooms is not an array', {data: {rooms: 'nope'}}],
        ['a null body', null],
    ])('fetch falls back to an empty list when the body has %s', async (_label, response) => {
        mattermostApiRequest.mockResolvedValue(response);

        await expect(fetchVoiceRooms()).resolves.toEqual([]);
    });

    test('create posts the room and returns the refreshed directory', async () => {
        const rooms = [{roomId: 'r1', name: 'Standup'}];
        mattermostApiRequest.mockResolvedValue({data: {rooms}});

        await expect(createVoiceRoom('r1', 'Standup')).resolves.toEqual(rooms);
        expect(mattermostApiRequest).toHaveBeenCalledWith({
            method: 'post',
            url: roomsUrl,
            data: {roomId: 'r1', name: 'Standup'},
        });
    });

    test('delete escapes the room id it puts in the query string', async () => {
        mattermostApiRequest.mockResolvedValue({data: {rooms: []}});

        await expect(deleteVoiceRoom('a b&c=d')).resolves.toEqual([]);
        expect(mattermostApiRequest).toHaveBeenCalledWith({
            method: 'delete',
            url: `${roomsUrl}?roomId=a%20b%26c%3Dd`,
        });
    });

    test('a heartbeat reports the room and returns the refreshed directory', async () => {
        const rooms = [{roomId: 'r1', name: 'Standup', participants: [{id: 'u1'}]}];
        mattermostApiRequest.mockResolvedValue({data: {rooms}});

        await expect(sendVoicePresence('r1', false)).resolves.toEqual(rooms);
        expect(mattermostApiRequest).toHaveBeenCalledWith({
            method: 'post',
            url: '/plugins/mattermost-webrtc-video/v1/voice/presence',
            data: {roomId: 'r1', audioOn: false},
        });
    });

    // Leaving is the same call with no room, so one endpoint covers both.
    test.each([
        ['an empty string', ''],
        ['null', null],
    ])('leaving sends %s as no room at all', async (_label, roomId) => {
        mattermostApiRequest.mockResolvedValue({data: {rooms: []}});

        await sendVoicePresence(roomId);

        expect(mattermostApiRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: {roomId: '', audioOn: true},
        }));
    });

    test('errors propagate so the caller can tell the user', async () => {
        const failure = new Error('403');
        mattermostApiRequest.mockRejectedValue(failure);

        await expect(deleteVoiceRoom('r1')).rejects.toThrow('403');
    });
});
