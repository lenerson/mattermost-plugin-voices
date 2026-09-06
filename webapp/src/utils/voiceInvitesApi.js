import {id as pluginId} from '../manifest';

import {mattermostApiRequest} from './mattermostApi';

export async function searchVoiceInviteUsers(term) {
    const response = await mattermostApiRequest({
        method: 'post',
        url: '/api/v4/users/search',
        data: {
            term: (term || '').trim(),
            allow_inactive: false,
        },
    });

    return response && Array.isArray(response.data) ? response.data : [];
}

export async function sendVoiceRoomInvite(roomId, targetUserId) {
    await mattermostApiRequest({
        method: 'post',
        url: `/plugins/${pluginId}/v1/voice/invite`,
        data: {roomId, targetUserId},
    });
}

export async function respondVoiceRoomInvite(postId, inviteId, decision) {
    await mattermostApiRequest({
        method: 'post',
        url: `/plugins/${pluginId}/v1/voice/invite/response`,
        data: {postId, inviteId, decision},
    });
}
