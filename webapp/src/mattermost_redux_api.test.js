/**
 * Guards every symbol the plugin imports from mattermost-redux against what the
 * installed package actually exports.
 *
 * A named import that does not exist is not a build error — webpack resolves it
 * to undefined, and it only fails when something calls it. `getDirectChannels`
 * was renamed out of mattermost-redux 11, and the resulting TypeError ran inside
 * mapStateToProps, so the DM picker was pulled out of the page with nothing to
 * show for it. This is the cheap way to catch the next such rename.
 */
const fs = require('fs');
const path = require('path');

const WEBAPP_ROOT = path.join(__dirname, '..');
const SRC_ROOT = __dirname;
const PACKAGE_ROOT = path.join(WEBAPP_ROOT, 'node_modules', 'mattermost-redux');

function sourceFiles(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return sourceFiles(full);
        }
        if ((/\.jsx?$/).test(entry.name) && !(/\.test\.jsx?$/).test(entry.name)) {
            return [full];
        }
        return [];
    });
}

function namedImports() {
    const pattern = /import\s*\{([^}]+)\}\s*from\s*'(mattermost-redux\/[^']+)'/g;
    const found = [];

    for (const file of sourceFiles(SRC_ROOT)) {
        const source = fs.readFileSync(file, 'utf8');
        let match = pattern.exec(source);
        while (match !== null) {
            const symbols = match[1].split(',').
                map((name) => name.trim().split(' as ')[0].trim()).
                filter(Boolean);
            for (const symbol of symbols) {
                found.push({
                    symbol,
                    module: match[2],
                    file: path.relative(WEBAPP_ROOT, file),
                });
            }
            match = pattern.exec(source);
        }
    }
    return found;
}

// Resolve through the package's own exports map, wildcard included, so the test
// looks up exactly the file webpack would bundle.
function resolveModule(moduleName) {
    const {exports: exportsMap} = JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    );
    const subpath = './' + moduleName.split('mattermost-redux/')[1];
    const wildcard = exportsMap['./*'];

    let target = exportsMap[subpath];
    if (!target && wildcard) {
        target = wildcard.replace('*', subpath.slice(2));
    }
    if (!target) {
        return null;
    }
    return path.join(PACKAGE_ROOT, target.replace(/^\.\//, ''));
}

function exportsSymbol(body, symbol) {
    return new RegExp('exports\\.' + symbol + '\\b').test(body);
}

function isMissing(entry) {
    const resolved = resolveModule(entry.module);
    if (!resolved || !fs.existsSync(resolved)) {
        return true;
    }
    return !exportsSymbol(fs.readFileSync(resolved, 'utf8'), entry.symbol);
}

function describeEntry(entry) {
    return entry.symbol + ' from ' + entry.module + ' (' + entry.file + ')';
}

function moduleResolves(moduleName) {
    const resolved = resolveModule(moduleName);
    return Boolean(resolved) && fs.existsSync(resolved);
}

const IMPORTS = namedImports();
const MODULES = [...new Set(IMPORTS.map((entry) => entry.module))];

describe('mattermost-redux imports', () => {
    test('the plugin imports symbols, so the scan is not vacuous', () => {
        expect(IMPORTS.length).toBeGreaterThan(0);
    });

    test.each(MODULES)('%s resolves to a real file', (moduleName) => {
        expect(moduleResolves(moduleName)).toBe(true);
    });

    test('every named import exists in the installed package', () => {
        expect(IMPORTS.filter(isMissing).map(describeEntry)).toEqual([]);
    });
});
