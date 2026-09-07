import {userDisplayName} from './dmPickerPeers';

/*
 * userDisplayName is what the voice roster and the DM picker both put on screen,
 * so its fallbacks decide whether someone is shown by name or by raw user id.
 */
describe('userDisplayName', () => {
    test('prefers the full name', () => {
        expect(userDisplayName({
            first_name: 'Lenerson',
            last_name: 'Velho Nunes',
            username: 'lenerson.nunes',
            id: 'abc',
        })).toBe('Lenerson Velho Nunes');
    });

    test.each([
        ['only a first name', {first_name: 'Lenerson', last_name: ''}, 'Lenerson'],
        ['only a last name', {first_name: '', last_name: 'Nunes'}, 'Nunes'],
    ])('handles %s', (_label, user, expected) => {
        expect(userDisplayName({...user, username: 'handle', id: 'abc'})).toBe(expected);
    });

    test('falls back to the username when there is no real name', () => {
        expect(userDisplayName({first_name: '', last_name: '', username: 'lenerson.nunes', id: 'abc'})).
            toBe('lenerson.nunes');
    });

    test('whitespace-only names do not count as a name', () => {
        expect(userDisplayName({first_name: '   ', last_name: '  ', username: 'handle', id: 'abc'})).toBe('handle');
    });

    // The id is the last resort inside this helper; the voice roster treats an
    // empty result as "not resolved" and shows a label instead of the raw id.
    test('returns an empty string for a missing user', () => {
        expect(userDisplayName(null)).toBe('');
    });

    test('returns an empty string when called with no argument', () => {
        expect(userDisplayName()).toBe('');
    });
});
