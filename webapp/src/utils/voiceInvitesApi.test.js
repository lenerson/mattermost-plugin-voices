import {respondVoiceRoomInvite, sendVoiceRoomInvite, searchVoiceInviteUsers} from './voiceInvitesApi';
import {mattermostApiRequest} from './mattermostApi';

jest.mock('./mattermostApi', () => ({
    mattermostApiRequest: jest.fn(),
}));

describe('voiceInvitesApi', () => {
    beforeEach(() => {
        mattermostApiRequest.mockReset();
    });

    test('searches active Mattermost users', async () => {
        const users = [{id: 'user-2', username: 'guest'}];
        mattermostApiRequest.mockResolvedValue({data: users});

        await expect(searchVoiceInviteUsers(' guest ')).resolves.toEqual(users);
        expect(mattermostApiRequest).toHaveBeenCalledWith({
            method: 'post',
            url: '/api/v4/users/search',
            data: {term: 'guest', allow_inactive: false},
        });
    });

    test('returns an empty list for malformed search responses', async () => {
        mattermostApiRequest.mockResolvedValue({data: {users: []}});

        await expect(searchVoiceInviteUsers('guest')).resolves.toEqual([]);
    });

    test('sends a room invite through the plugin endpoint', async () => {
        mattermostApiRequest.mockResolvedValue({status: 204});

        await sendVoiceRoomInvite('room-1', 'user-2');

        expect(mattermostApiRequest).toHaveBeenCalledWith({
            method: 'post',
            url: '/plugins/mattermost-webrtc-video/v1/voice/invite',
            data: {roomId: 'room-1', targetUserId: 'user-2'},
        });
    });

    test('responds to a persisted room invitation', async () => {
        mattermostApiRequest.mockResolvedValue({status: 204});

        await respondVoiceRoomInvite('post-1', 'invite-1', 'accepted');

        expect(mattermostApiRequest).toHaveBeenCalledWith({
            method: 'post',
            url: '/plugins/mattermost-webrtc-video/v1/voice/invite/response',
            data: {postId: 'post-1', inviteId: 'invite-1', decision: 'accepted'},
        });
    });
});
