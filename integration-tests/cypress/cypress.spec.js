'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const webAppServer = require('../ci-visibility/web-app-server')
const coverageFixture = require('../ci-visibility/fixtures/coverage.json')
const {
  TEST_STATUS,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_FRAMEWORK_VERSION,
  TEST_TOOLCHAIN,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')

// TODO: remove when 2.x support is removed.
// This is done because from cypress@>11.2.0 node 12 is not supported
const versions = ['6.7.0', NODE_MAJOR <= 12 ? '11.2.0' : 'latest']

versions.forEach((version) => {
  describe(`cypress@${version}`, function () {
    this.retries(2)
    this.timeout(60000)
    let sandbox, cwd, receiver, childProcess, webAppPort
    const commandSuffix = version === '6.7.0' ? '--config-file cypress-config.json' : ''
    before(async () => {
      sandbox = await createSandbox([`cypress@${version}`], true)
      cwd = sandbox.folder
      webAppPort = await getPort()
      webAppServer.listen(webAppPort)
    })

    after(async () => {
      await sandbox.remove()
      await new Promise(resolve => webAppServer.close(resolve))
    })

    beforeEach(async function () {
      const port = await getPort()
      receiver = await new FakeCiVisIntake(port).start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    it('catches errors in hooks', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        // test level hooks
        const testHookSuite = events.find(
          event => event.content.resource === 'test_suite.cypress/e2e/hook-test-error.cy.js'
        )
        const passedTest = events.find(
          event => event.content.resource === 'cypress/e2e/hook-test-error.cy.js.hook-test-error tests passes'
        )
        const failedTest = events.find(
          event => event.content.resource ===
            'cypress/e2e/hook-test-error.cy.js.hook-test-error tests will fail because afterEach fails'
        )
        const skippedTest = events.find(
          event => event.content.resource ===
            'cypress/e2e/hook-test-error.cy.js.hook-test-error tests does not run because earlier afterEach fails'
        )
        assert.equal(passedTest.content.meta[TEST_STATUS], 'pass')
        assert.equal(failedTest.content.meta[TEST_STATUS], 'fail')
        assert.include(failedTest.content.meta[ERROR_MESSAGE], 'error in after each hook')
        assert.equal(skippedTest.content.meta[TEST_STATUS], 'skip')
        assert.equal(testHookSuite.content.meta[TEST_STATUS], 'fail')
        assert.include(testHookSuite.content.meta[ERROR_MESSAGE], 'error in after each hook')

        // describe level hooks
        const describeHookSuite = events.find(
          event => event.content.resource === 'test_suite.cypress/e2e/hook-describe-error.cy.js'
        )
        const passedTestDescribe = events.find(
          event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.after passes'
        )
        const failedTestDescribe = events.find(
          event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.after will be marked as failed'
        )
        const skippedTestDescribe = events.find(
          event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.before will be skipped'
        )
        assert.equal(passedTestDescribe.content.meta[TEST_STATUS], 'pass')
        assert.equal(failedTestDescribe.content.meta[TEST_STATUS], 'fail')
        assert.include(failedTestDescribe.content.meta[ERROR_MESSAGE], 'error in after hook')
        assert.equal(skippedTestDescribe.content.meta[TEST_STATUS], 'skip')
        assert.equal(describeHookSuite.content.meta[TEST_STATUS], 'fail')
        assert.include(describeHookSuite.content.meta[ERROR_MESSAGE], 'error in after hook')
      }, 25000).then(() => done()).catch(done)

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
          },
          stdio: 'pipe'
        }
      )
    })

    it('can run and report tests', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const testModuleEvent = events.find(event => event.type === 'test_module_end')
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const testEvents = events.filter(event => event.type === 'test')

        const { content: testSessionEventContent } = testSessionEvent
        const { content: testModuleEventContent } = testModuleEvent

        assert.exists(testSessionEventContent.test_session_id)
        assert.exists(testSessionEventContent.meta[TEST_COMMAND])
        assert.exists(testSessionEventContent.meta[TEST_TOOLCHAIN])
        assert.equal(testSessionEventContent.resource.startsWith('test_session.'), true)
        assert.equal(testSessionEventContent.meta[TEST_STATUS], 'fail')

        assert.exists(testModuleEventContent.test_session_id)
        assert.exists(testModuleEventContent.test_module_id)
        assert.exists(testModuleEventContent.meta[TEST_COMMAND])
        assert.exists(testModuleEventContent.meta[TEST_MODULE])
        assert.equal(testModuleEventContent.resource.startsWith('test_module.'), true)
        assert.equal(testModuleEventContent.meta[TEST_STATUS], 'fail')
        assert.equal(
          testModuleEventContent.test_session_id.toString(10),
          testSessionEventContent.test_session_id.toString(10)
        )
        assert.exists(testModuleEventContent.meta[TEST_FRAMEWORK_VERSION])

        assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
          'test_suite.cypress/e2e/other.cy.js',
          'test_suite.cypress/e2e/spec.cy.js'
        ])

        assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
          'pass',
          'fail'
        ])

        testSuiteEvents.forEach(({
          content: {
            meta,
            test_suite_id: testSuiteId,
            test_module_id: testModuleId,
            test_session_id: testSessionId
          }
        }) => {
          assert.exists(meta[TEST_COMMAND])
          assert.exists(meta[TEST_MODULE])
          assert.exists(testSuiteId)
          assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
          assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
        })

        assert.includeMembers(testEvents.map(test => test.content.resource), [
          'cypress/e2e/other.cy.js.context passes',
          'cypress/e2e/spec.cy.js.context passes',
          'cypress/e2e/spec.cy.js.other context fails'
        ])

        assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
          'pass',
          'pass',
          'fail'
        ])

        testEvents.forEach(({
          content: {
            meta,
            test_suite_id: testSuiteId,
            test_module_id: testModuleId,
            test_session_id: testSessionId
          }
        }) => {
          assert.exists(meta[TEST_COMMAND])
          assert.exists(meta[TEST_MODULE])
          assert.exists(testSuiteId)
          assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
          assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
        })
      }, 25000).then(() => done()).catch(done)

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
          },
          stdio: 'pipe'
        }
      )
    })

    it('can report code coverage if it is available', (done) => {
      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisAgentlessConfig(receiver.port)

      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcov', payloads => {
        const [{ payload: coveragePayloads }] = payloads
        const coverages = coveragePayloads.map(coverage => coverage.content)
          .flatMap(content => content.coverages)

        coverages.forEach(coverage => {
          assert.property(coverage, 'test_session_id')
          assert.property(coverage, 'test_suite_id')
          assert.property(coverage, 'span_id')
          assert.property(coverage, 'files')
        })

        const fileNames = coverages
          .flatMap(coverageAttachment => coverageAttachment.files)
          .map(file => file.filename)

        assert.includeMembers(fileNames, Object.keys(coverageFixture))
      }, 20000).then(() => done()).catch(done)

      childProcess = exec(
        `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
          },
          stdio: 'pipe'
        }
      )
    })

    context('intelligent test runner', () => {
      it('can report git metadata', (done) => {
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url.endsWith('/api/v2/git/repository/search_commits')
        )
        const packfileRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/git/repository/packfile'))

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )
        childProcess.on('exit', () => {
          Promise.all([
            searchCommitsRequestPromise,
            packfileRequestPromise
          ]).then(([searchCommitRequest, packfileRequest]) => {
            assert.propertyVal(searchCommitRequest.headers, 'dd-api-key', '1')
            assert.propertyVal(packfileRequest.headers, 'dd-api-key', '1')
            done()
          }).catch(done)
        })
      })
      it('does not report code coverage if disabled by the API', (done) => {
        receiver.setSettings({
          code_coverage: false,
          tests_skipping: false
        })

        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report code coverage')
          done(error)
        }, ({ url }) => url.endsWith('/api/v2/citestcov')).catch(() => {})

        receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const eventTypes = events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        }, 25000).then(() => done()).catch(done)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )
      })
      it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'context passes',
            suite: 'cypress/e2e/other.cy.js'
          }
        }])
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const eventTypes = events.map(event => event.type)

            const skippedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/other.cy.js.context passes'
            )
            assert.notExists(skippedTest)
            assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
            assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            const testModule = events.find(event => event.type === 'test_module_end').content
            assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'true')
            assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
          }, 25000)
        const skippableRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))
          .then(skippableRequest => {
            assert.propertyVal(skippableRequest.headers, 'dd-api-key', '1')
            assert.propertyVal(skippableRequest.headers, 'dd-application-key', '1')
          })

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )
        childProcess.on('exit', () => {
          Promise.all([eventsPromise, skippableRequestPromise]).then(() => {
            done()
          }).catch(done)
        })
      })
      it('does not skip tests if test skipping is disabled by the API', (done) => {
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: false
        })

        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'context passes',
            suite: 'cypress/e2e/other.cy.js'
          }
        }])

        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url.endsWith('/api/v2/ci/tests/skippable')).catch(() => {})

        receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const notSkippedTest = events.find(event =>
            event.content.resource === 'cypress/e2e/other.cy.js.context passes'
          )
          assert.exists(notSkippedTest)
        }, 25000).then(() => done()).catch(done)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )
      })
    })
  })
})
