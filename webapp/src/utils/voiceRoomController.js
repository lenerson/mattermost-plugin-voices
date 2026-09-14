import debug from './debug';

export default class VoiceRoomController {
    constructor({fetchRooms, sendPresence, onRooms, onError, setIntervalFn = setInterval, clearIntervalFn = clearInterval}) {
        this.fetchRooms = fetchRooms;
        this.sendPresence = sendPresence;
        this.onRooms = onRooms;
        this.onError = onError;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.directoryPoll = null;
        this.presenceHeartbeat = null;
    }

    refresh() {
        return this.fetchRooms().
            then((rooms) => this.onRooms(rooms)).
            catch((error) => this.handleError('Could not load the voice channels.', error));
    }

    startDirectory(intervalMs) {
        if (this.directoryPoll) {
            return;
        }
        this.refresh();
        this.directoryPoll = this.setIntervalFn(() => this.refresh(), intervalMs);
    }

    stopDirectory() {
        if (this.directoryPoll) {
            this.clearIntervalFn(this.directoryPoll);
            this.directoryPoll = null;
        }
    }

    announcePresence(roomId, microphoneOn) {
        return this.sendPresence(roomId, microphoneOn).
            then((rooms) => this.onRooms(rooms)).
            catch((error) => this.handleError('Could not update voice presence.', error));
    }

    startPresence(roomId, microphoneOn, intervalMs) {
        this.stopPresence();
        this.announcePresence(roomId, microphoneOn);
        this.presenceHeartbeat = this.setIntervalFn(() => this.announcePresence(roomId, microphoneOn()), intervalMs);
    }

    stopPresence() {
        if (this.presenceHeartbeat) {
            this.clearIntervalFn(this.presenceHeartbeat);
            this.presenceHeartbeat = null;
        }
    }

    clearPresence() {
        this.stopPresence();
        return this.announcePresence('', false);
    }

    handleError(message, error) {
        debug(message, error);
        this.onError(message, error);
    }
}
