const DEBUG_STORAGE_KEY = 'mattermost-plugin-voices.debug';
const REDACTED = '[REDACTED]';
const sensitiveKeyPattern = /authorization|candidate|cookie|credential|ice|password|sdp|secret|token|turn/i;

// Set localStorage[DEBUG_STORAGE_KEY] to "true" to enable diagnostics in a
// production build. Logging remains sanitized in every build mode.

function isPlainObject(value) {
    if (Object.prototype.toString.call(value) !== '[object Object]') {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeStorageValue() {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const storage = window.localStorage;
        return storage ? storage.getItem(DEBUG_STORAGE_KEY) : null;
    } catch (e) {
        return null;
    }
}

export function isDebugEnabled() {
    const configuredValue = safeStorageValue();
    if (configuredValue === 'true') {
        return true;
    }
    if (configuredValue === 'false') {
        return false;
    }

    return typeof process === 'undefined' || process.env.NODE_ENV !== 'production'; // eslint-disable-line no-process-env
}

function opaqueObjectName(value) {
    const constructorName = value && value.constructor && value.constructor.name;
    return `[${constructorName || 'Object'}]`;
}

function sanitizeValue(value, seen) {
    if (value == null || typeof value !== 'object') {
        return value;
    }

    if (seen.has(value)) {
        return '[Circular]';
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
        };
    }

    if (Array.isArray(value)) {
        seen.add(value);
        return value.map((entry) => sanitizeValue(entry, seen));
    }

    if (!isPlainObject(value)) {
        return opaqueObjectName(value);
    }

    seen.add(value);
    return Object.keys(value).reduce((result, key) => {
        result[key] = sensitiveKeyPattern.test(key) ? REDACTED : sanitizeValue(value[key], seen);
        return result;
    }, {});
}

export function sanitizeDebugArgs(args) {
    const seen = new WeakSet();
    return args.map((arg) => sanitizeValue(arg, seen));
}

export default (...args) => {
    if (isDebugEnabled()) {
        console.log(...sanitizeDebugArgs(args)); // eslint-disable-line no-console
    }
};
