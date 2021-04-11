const CriConnection = require('lighthouse/lighthouse-core/gather/connections/cri');
const lighthouse = require('lighthouse');
const log = require('lighthouse-logger');
const GatherRunner = require('lighthouse/lighthouse-core/gather/gather-runner');
const Driver = require('lighthouse/lighthouse-core/gather/driver.js');
const Runner = require('lighthouse/lighthouse-core/runner');
const { getBenchmarkIndex } = require('lighthouse/lighthouse-core/gather/driver/environment');

class ChromeConnection extends CriConnection {
    /**
     * Connects to the first opened page (first tab)
     */
    connect() {
        return this._runJsonCommand('list').then((tabs) => {
            if (!Array.isArray(tabs) || tabs.length === 0) {
                return Promise.reject(new Error('Cannot create new tab, and no tabs already open.'));
            }
            const firstTab = tabs[0];

            // first, we activate it to a foreground tab, then we connect
            return this._runJsonCommand(`activate/${firstTab.id}`)
                .then(() => this._connectToSocket(firstTab));
        });
    }

    /**
     * Connect to the opened page by provided pageId
     * @param {Object} devToolsData: {pageId, debugPort}
     * @returns {Promise}
     */
    connectToPage(devToolsData) {
        const pageData = {
            webSocketDebuggerUrl: `ws://localhost:${devToolsData.debugPort}/devtools/page/${devToolsData.pageId}`,
            id: devToolsData.pageId,
        };

        return this._connectToSocket(pageData);
    }
}

/**
 * @param {Array<LH.Config.Pass>} passConfigs
 * @param {{driver: Driver, requestedUrl: string, settings: LH.Config.Settings}} options
 * @return {Promise<LH.Artifacts>}
 */
async function runGatherRunner(passConfigs, options, shouldDisposeDriver = false) {
    const { driver } = options;

    /** @type {Partial<LH.GathererArtifacts>} */
    const artifacts = {};

    try {
        await driver.connect();
        // In the devtools/extension case, we can't still be on the site while trying to clear state
        // So we first navigate to about:blank, then apply our emulation & setup
        await GatherRunner.loadBlank(driver);

        const baseArtifacts = await GatherRunner.initializeBaseArtifacts(options);

        baseArtifacts.BenchmarkIndex = await getBenchmarkIndex(driver.executionContext);

        await GatherRunner.setupDriver(driver, options, baseArtifacts.LighthouseRunWarnings);

        let isFirstPass = true;

        // eslint-disable-next-line no-restricted-syntax
        for (const passConfig of passConfigs) {
            /** @type {LH.Gatherer.PassContext} */
            const passContext = {
                gatherMode: 'navigation',
                driver,
                url: options.requestedUrl,
                settings: options.settings,
                passConfig,
                baseArtifacts,
                LighthouseRunWarnings: baseArtifacts.LighthouseRunWarnings,
            };
            // eslint-disable-next-line no-await-in-loop
            const passResults = await GatherRunner.runPass(passContext);

            Object.assign(artifacts, passResults.artifacts);

            // If we encountered a pageLoadError, don't try to keep loading the page in future passes.
            if (passResults.pageLoadError && passConfig.loadFailureMode === 'fatal') {
                baseArtifacts.PageLoadError = passResults.pageLoadError;
                break;
            }

            if (isFirstPass) {
                // eslint-disable-next-line no-await-in-loop
                await GatherRunner.populateBaseArtifacts(passContext);
                isFirstPass = false;
            }

            // eslint-disable-next-line no-await-in-loop
            await driver.fetcher.disableRequestInterception();
        }

        if (shouldDisposeDriver) {
            await GatherRunner.disposeDriver(driver, options);
        }
        GatherRunner.finalizeBaseArtifacts(baseArtifacts);

        return /** @type {LH.Artifacts} */ ({...baseArtifacts, ...artifacts}); // Cast to drop Partial<>.
    } catch (err) {
        // Clean up on error. Don't await so that the root error, not a disposal error, is shown.
        GatherRunner.disposeDriver(driver, options);

        throw err;
    }
}

async function gatherArtifactsFromBrowser(requestedUrl, runnerOpts, connection) {
    if (!runnerOpts.config.passes) {
        throw new Error('No browser artifacts are either provided or requested.');
    }
    const driver = runnerOpts.driverMock || new Driver(connection);
    const gatherOpts = {
        driver,
        requestedUrl,
        settings: runnerOpts.config.settings,
    };
    const artifacts = await runGatherRunner(runnerOpts.config.passes, gatherOpts);

    return artifacts;
}

/**
 * Run Lighthouse.
 * @param {string=} url The URL to test. Optional if running in auditMode.
 * @param {LH.Flags=} flags Optional settings for the Lighthouse run. If present,
 *   they will override any settings in the config.
 * @param {LH.Config.Json=} configJSON Configuration for the Lighthouse run. If
 *   not present, the default config is used.
 * @param {Object} devToolsInfo {pageId, debugPort}
 * @return {Promise<LH.RunnerResult|undefined>}
 */
async function lighthouseAdapter(url, flags = {}, configJSON, devToolsInfo) {
    if (!('pageId' in devToolsInfo && 'debugPort' in devToolsInfo)) {
        throw new Error('Param "devToolsInfo" should be an object with properties pageId and debugPort.');
    }
    // set logging preferences, assume quiet
    flags.logLevel = flags.logLevel || 'error';
    log.setLevel(flags.logLevel);

    const config = lighthouse.generateConfig(configJSON, flags);
    const options = {url, config};
    const connection = new ChromeConnection(flags.port, flags.hostname);

    // kick off a lighthouse run
    const gatherFn = async ({requestedUrl}) => {
        const artifacts = await gatherArtifactsFromBrowser(requestedUrl, options, connection, devToolsInfo);

        return artifacts;
    };

    return Runner.run(gatherFn, options);
}

exports.lighthouseAdapter = lighthouseAdapter;
