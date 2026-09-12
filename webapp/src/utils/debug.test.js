import debug, {isDebugEnabled, sanitizeDebugArgs} from './debug';

const debugStorageKey = 'mattermost-plugin-voices.debug';
let debugStorageValue;

function getDebugStorageValue() {
    return debugStorageValue;
}

describe('debug', () => {
    let consoleLog;
    let originalNodeEnv;

    beforeEach(() => {
        consoleLog = jest.spyOn(console, 'log').mockImplementation(jest.fn());
        originalNodeEnv = process.env.NODE_ENV; // eslint-disable-line no-process-env
        debugStorageValue = null;
        global.window = {
            localStorage: {
                getItem: jest.fn(getDebugStorageValue),
            },
        };
    });

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv; // eslint-disable-line no-process-env
        delete global.window;
        consoleLog.mockRestore();
    });

    test('redacts TURN credentials and signalling values recursively', () => {
        const [sanitized] = sanitizeDebugArgs([{
            publicValue: 'kept',
            turnServerCredential: 'turn-secret',
            nested: {
                sdp: 'v=0',
                candidate: 'candidate:1',
                authorization: 'Bearer secret',
            },
            iceServers: [{credential: 'another-secret'}],
        }]);

        expect(sanitized).toEqual({
            publicValue: 'kept',
            turnServerCredential: '[REDACTED]',
            nested: {
                sdp: '[REDACTED]',
                candidate: '[REDACTED]',
                authorization: '[REDACTED]',
            },
            iceServers: '[REDACTED]',
        });
        expect(JSON.stringify(sanitized)).not.toContain('turn-secret');
        expect(JSON.stringify(sanitized)).not.toContain('candidate:1');
    });

    test('does not expand browser and WebRTC objects', () => {
        class PeerConnection {
        }

        expect(sanitizeDebugArgs([new PeerConnection()])).toEqual(['[PeerConnection]']);
    });

    test('is disabled by default in production', () => {
        process.env.NODE_ENV = 'production'; // eslint-disable-line no-process-env

        expect(isDebugEnabled()).toBe(false);
        debug('should not be logged');
        expect(consoleLog).not.toHaveBeenCalled();
    });

    test('can be enabled explicitly while preserving sanitization', () => {
        process.env.NODE_ENV = 'production'; // eslint-disable-line no-process-env
        debugStorageValue = 'true';

        debug('configuration', {turnServerCredential: 'turn-secret'});

        expect(global.window.localStorage.getItem).toHaveBeenCalledWith(debugStorageKey);
        expect(consoleLog).toHaveBeenCalledWith('configuration', {turnServerCredential: '[REDACTED]'});
    });
});
