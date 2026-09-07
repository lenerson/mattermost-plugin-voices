/**
 * Voice channel directory, served by the plugin's KV store.
 *
 * Rooms used to live only in each browser's localStorage, announced once over
 * the signal broker when they were created. The broker keeps no history, so a
 * room was invisible to anyone who was not already subscribed at that exact
 * moment — which is why a channel you created only ever showed up for you.
 *
 * Imports `../manifest` rather than `manifest`: the webpack alias resolves both,
 * but jest has no moduleDirectories config and only understands the relative one.
 */
import {id as pluginId} from '../manifest';

import {mattermostApiRequest} from './mattermostApi';

function roomsUrl() {
    return `/plugins/${pluginId}/v1/voice/rooms`;
}

/**
 * Every endpoint answers with the full directory, so create and delete refresh
 * the caller's list without a follow-up GET.
 */
function toRooms(response) {
    const rooms = response && response.data && response.data.rooms;
    return Array.isArray(rooms) ? rooms : [];
}

export async function fetchVoiceRooms() {
    const response = await mattermostApiRequest({
        method: 'get',
        url: roomsUrl(),
    });
    return toRooms(response);
}

export async function createVoiceRoom(roomId, name) {
    const response = await mattermostApiRequest({
        method: 'post',
        url: roomsUrl(),
        data: {roomId, name},
    });
    return toRooms(response);
}

/**
 * Report that we are in a room, or — with no roomId — in none.
 *
 * Presence has to be server state: everyone inside a room knows who else is
 * there through the audio mesh, but that is exactly the people who do not need
 * telling. Someone looking at the sidebar has no connection to the room at all.
 *
 * The server answers with the refreshed directory, so a heartbeat doubles as a
 * poll and the panel stays current without a second request.
 */
export async function sendVoicePresence(roomId, audioOn = true) {
    const response = await mattermostApiRequest({
        method: 'post',
        url: `/plugins/${pluginId}/v1/voice/presence`,
        data: {roomId: roomId || '', audioOn: Boolean(audioOn)},
    });
    return toRooms(response);
}

export async function deleteVoiceRoom(roomId) {
    const response = await mattermostApiRequest({
        method: 'delete',
        url: `${roomsUrl()}?roomId=${encodeURIComponent(roomId)}`,
    });
    return toRooms(response);
}
