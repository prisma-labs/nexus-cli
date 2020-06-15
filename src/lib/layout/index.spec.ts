import { log } from '@nexus/logger'
import { defaultsDeep } from 'lodash'
import { TsConfigJson } from 'type-fest'
import * as Layout from '.'
import { FSSpec, writeFSSpec } from '../../lib/testing-utils'
import { leftOrThrow, rightOrThrow } from '../glocal/utils'
import * as TC from '../test-context'
import { repalceInObject, replaceEvery } from '../utils'
import { NEXUS_TS_LSP_IMPORT_ID } from './tsconfig'

let mockedStdoutBuffer: string = ''

log.settings({
  output: {
    write(data) {
      mockedStdoutBuffer += data
    },
  },
})

afterEach(() => {
  mockedStdoutBuffer = ''
})

const mockExit = jest.spyOn(process, 'exit').mockImplementation(((n: any) => {
  mockedStdoutBuffer += `\n\n--- process.exit(${n}) ---\n\n`
}) as any)

/**
 * Disable logger timeDiff and color to allow snapshot matching
 */
log.settings({
  pretty: {
    enabled: true,
    timeDiff: false,
    color: false,
  },
})

// Force stdout width to not wrap the logs and mess with the snapshots
process.stdout.columns = 300

/**
 * Helpers
 */

function tsconfig(input?: TsConfigJson): TsConfigJson {
  const defaultTsConfigContent: TsConfigJson = {
    compilerOptions: {
      noEmit: true,
      rootDir: '.',
      plugins: [{ name: NEXUS_TS_LSP_IMPORT_ID }],
    },
    include: ['.'],
  }
  return defaultsDeep(input, defaultTsConfigContent)
}
/**
 * Create tsconfig content. Defaults to minimum valid tsconfig needed by Nexus. Passed config will override and merge using lodash deep defaults.
 */
function tsconfigSource(input?: TsConfigJson): string {
  return JSON.stringify(tsconfig(input))
}

const ctx = TC.create(
  TC.tmpDir(),
  TC.fs(),
  TC.createContributor((ctx) => {
    return {
      setup(spec: FSSpec = {}) {
        writeFSSpec(ctx.tmpDir, spec)
      },
      stripTmpDir(x: object | string) {
        return typeof x === 'string'
          ? replaceEvery(x, ctx.tmpDir, '__DYNAMIC__')
          : repalceInObject(ctx.tmpDir, '__DYNAMIC__', x)
      },
      async createLayoutThrow(opts?: { entrypointPath?: string; buildOutput?: string }) {
        const data = rightOrThrow(
          await Layout.create({
            projectRoot: ctx.tmpDir,
            entrypointPath: opts?.entrypointPath,
            buildOutputDir: opts?.buildOutput,
            asBundle: false,
          })
        )
        mockedStdoutBuffer = mockedStdoutBuffer.split(ctx.tmpDir).join('__DYNAMIC__')
        return repalceInObject(ctx.tmpDir, '__DYNAMIC__', data.data)
      },
      async createLayout(opts?: { entrypointPath?: string; buildOutput?: string }) {
        return Layout.create({
          projectRoot: ctx.tmpDir,
          entrypointPath: opts?.entrypointPath,
          buildOutputDir: opts?.buildOutput,
          asBundle: false,
        }).then((v) => repalceInObject(ctx.tmpDir, '__DYNAMIC__', v))
      },
    }
  })
)

const nestTmpDir = () => {
  const projectRootPath = ctx.fs.path('project-root')
  ctx.fs.dir(projectRootPath)
  ctx.fs = ctx.fs.cwd(projectRootPath)
}

/**
 * Tests
 */

describe('projectRoot', () => {
  it('can be forced', () => {
    const projectRoot = ctx.fs.path('./foobar')
    ctx.fs.write('./foobar/app.ts', '')
    ctx.fs.dir(projectRoot)
    expect(Layout.create({ projectRoot }).then(rightOrThrow)).resolves.toMatchObject({ projectRoot })
  })
  it('otherwise uses first dir in hierarchy with a package.json', () => {
    nestTmpDir()
    ctx.fs.write('../package.json', { version: '0.0.0', name: 'foo' })
    ctx.fs.write('app.ts', '')
    expect(Layout.create({ cwd: ctx.fs.cwd() }).then(rightOrThrow)).resolves.toMatchObject({
      projectRoot: ctx.fs.path('..'),
    })
  })
  it('otherwise finally falls back to process cwd', () => {
    ctx.fs.write('app.ts', '')
    expect(Layout.create({ cwd: ctx.fs.cwd() }).then(rightOrThrow)).resolves.toMatchObject({
      projectRoot: ctx.fs.cwd(),
    })
  })
})

describe('sourceRoot', () => {
  it('defaults to project dir', async () => {
    ctx.setup({ 'tsconfig.json': '', 'app.ts': '' })
    const res = await ctx.createLayout().then(rightOrThrow)
    expect(res.sourceRoot).toEqual('__DYNAMIC__')
    expect(res.projectRoot).toEqual('__DYNAMIC__')
  })
  it('uses the value in tsconfig compilerOptions.rootDir if present', async () => {
    ctx.setup({ 'tsconfig.json': tsconfigSource({ compilerOptions: { rootDir: 'api' } }), 'api/app.ts': '' })
    const res = await ctx.createLayout().then(rightOrThrow)
    expect(res.sourceRoot).toMatchInlineSnapshot(`"__DYNAMIC__/api"`)
  })
})

describe('tsconfig', () => {
  beforeEach(() => {
    ctx.setup({ 'app.ts': '' })
  })

  it('fails if tsconfig settings does not lead to matching any source files', async () => {
    ctx.fs.remove('app.ts')
    const res = await ctx.createLayout().then(leftOrThrow)
    expect(res).toMatchInlineSnapshot(`
      Object {
        "context": Object {
          "diagnostics": Array [
            Object {
              "category": 1,
              "code": 18003,
              "messageText": "No inputs were found in config file '__DYNAMIC__/tsconfig.json'. Specified 'include' paths were '[\\".\\"]' and 'exclude' paths were '[\\".nexus/build\\"]'.",
            },
          ],
        },
        "type": "invalid_tsconfig",
      }
    `)
  })

  it('will scaffold tsconfig if not present', async () => {
    await ctx.createLayoutThrow()
    expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
      "▲ nexus:tsconfig We could not find a \\"tsconfig.json\\" file
      ▲ nexus:tsconfig We scaffolded one for you at __DYNAMIC__/tsconfig.json
      "
    `)
    expect(ctx.fs.read('tsconfig.json', 'json')).toMatchInlineSnapshot(`
      Object {
        "compilerOptions": Object {
          "lib": Array [
            "esnext",
          ],
          "module": "commonjs",
          "noEmit": true,
          "plugins": Array [
            Object {
              "name": "nexus/typescript-language-service",
            },
          ],
          "rootDir": ".",
          "strict": true,
          "target": "es2016",
        },
        "include": Array [
          ".",
        ],
      }
    `)
  })

  describe('linting', () => {
    it('enforces noEmit is true (explicit false)', async () => {
      ctx.setup({
        'tsconfig.json': tsconfigSource({ compilerOptions: { noEmit: false } }),
      })
      await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "▲ nexus:tsconfig Please set [93m\`compilerOptions.noEmit\`[39m to true. This will ensure you do not accidentally emit using [93m\`$ tsc\`[39m. Use [93m\`$ nexus build\`[39m to build your app and emit JavaScript.
        "
      `)
    })
    it('enforces noEmit is true (undefined)', async () => {
      const tscfg = tsconfig()
      delete tscfg.compilerOptions?.noEmit

      ctx.setup({
        'tsconfig.json': JSON.stringify(tscfg),
      })
      await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "▲ nexus:tsconfig Please set [93m\`compilerOptions.noEmit\`[39m to true. This will ensure you do not accidentally emit using [93m\`$ tsc\`[39m. Use [93m\`$ nexus build\`[39m to build your app and emit JavaScript.
        "
      `)
    })
    it('warns if reserved settings are in use', async () => {
      ctx.setup({
        'tsconfig.json': tsconfigSource({
          compilerOptions: {
            incremental: true,
            tsBuildInfoFile: 'foo',
          },
        }),
      })
      await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "▲ nexus:tsconfig You have set [93m\`compilerOptions.tsBuildInfoFile\`[39m but it will be ignored by Nexus. Nexus manages this value internally.
        ▲ nexus:tsconfig You have set [93m\`compilerOptions.incremental\`[39m but it will be ignored by Nexus. Nexus manages this value internally.
        "
      `)
    })
    it('warns if rootDir or include not set and sets them in memory', async () => {
      const tscfg = tsconfig()
      delete tscfg.compilerOptions?.rootDir
      delete tscfg.include

      ctx.setup({
        'tsconfig.json': JSON.stringify(tscfg),
      })
      const layout = await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "▲ nexus:tsconfig Please set [93m\`compilerOptions.rootDir\`[39m to \\".\\"
        ▲ nexus:tsconfig Please set [93m\`include\`[39m to have \\".\\"
        "
      `)
      expect(layout.tsConfig.content.raw.compilerOptions.rootDir).toEqual('.')
      expect(layout.tsConfig.content.raw.include).toEqual(['.'])
    })
    it('need the Nexus TS LSP setup', async () => {
      ctx.setup({
        'tsconfig.json': tsconfigSource({
          compilerOptions: { plugins: [{ name: 'foobar' }] },
        }),
      })

      await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "▲ nexus:tsconfig You have not added the Nexus TypeScript Language Service Plugin to your configured TypeScript plugins. Add this to your compilerOptions:

            [93m\\"plugins\\": [{\\"name\\":\\"foobar\\"},{\\"name\\":\\"nexus/typescript-language-service\\"}][39m

        "
      `)
    })
    it('does not support use of compilerOptions.types', async () => {
      ctx.setup({
        'tsconfig.json': tsconfigSource({ compilerOptions: { types: [] } }),
      })
      await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "■ nexus:tsconfig You have set [93m\`compilerOptions.types\`[39m but Nexus does not support it. If you do not remove your customization you may/will (e.g. VSCode) see inconsistent results between your IDE and what Nexus tells you at build time. If you would like to see Nexus support this setting please chime in at https://github.com/graphql-nexus/nexus/issues/1036.
        "
      `)
    })
    it('does not support use of compilerOptions.rootTypes', async () => {
      ctx.setup({
        'tsconfig.json': tsconfigSource({ compilerOptions: { typeRoots: [] } }),
      })
      await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "■ nexus:tsconfig You have set [93m\`compilerOptions.typeRoots\`[39m but Nexus does not support it. If you do not remove your customization you may/will (e.g. VSCode) see inconsistent results between your IDE and what Nexus tells you at build time. If you would like to see Nexus support this setting please chime in at https://github.com/graphql-nexus/nexus/issues/1036.
        "
      `)
    })
    it('outputs warning only once if both types and typeRoots is set', async () => {
      ctx.setup({
        'tsconfig.json': tsconfigSource({ compilerOptions: { typeRoots: [], types: [] } }),
      })
      await ctx.createLayoutThrow()
      expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
        "■ nexus:tsconfig You have set [93m\`compilerOptions.typeRoots\`[39m and [93m\`compilerOptions.types\`[39m but Nexus does not support them. If you do not remove your customization you may/will (e.g. VSCode) see inconsistent results between your IDE and what Nexus tells you at build time. If you would like to see Nexus support these settings please chime in at https://github.com/graphql-nexus/nexus/issues/1036.
        "
      `)
    })
  })

  it('will return exception if error reading file', async () => {
    ctx.setup({
      'tsconfig.json': 'bad json',
    })
    const res = await ctx.createLayout().then(leftOrThrow)
    expect(res).toMatchInlineSnapshot(`
      Object {
        "context": Object {},
        "message": "Unable to read your tsconifg.json

      [96m../../../../..__DYNAMIC__/tsconfig.json[0m:[93m1[0m:[93m1[0m - [91merror[0m[90m TS1005: [0m'{' expected.

      [7m1[0m bad json
      [7m [0m [91m~~~[0m
      ",
        "type": "generic",
      }
    `)
  })

  it('will return exception if invalid tsconfig schema', async () => {
    ctx.setup({
      'tsconfig.json': '{ "exclude": "bad" }',
    })
    const res = await ctx.createLayout().then(leftOrThrow)
    expect(res).toMatchInlineSnapshot(`
      Object {
        "context": Object {
          "diagnostics": Array [
            Object {
              "category": 1,
              "code": 5024,
              "messageText": "Compiler option 'exclude' requires a value of type Array.",
            },
          ],
        },
        "type": "invalid_tsconfig",
      }
    `)
  })
})

it('fails if no entrypoint and no nexus modules', async () => {
  ctx.setup({
    'tsconfig.json': tsconfigSource(),
    src: {
      'User.ts': '',
      'Post.ts': '',
    },
  })

  await ctx.createLayoutThrow()

  expect(mockedStdoutBuffer).toMatchInlineSnapshot(`
    "■ nexus:layout We could not find any modules that imports 'nexus' or app.ts entrypoint
    ■ nexus:layout Please do one of the following:

      1. Create a file, import { schema } from 'nexus' and write your GraphQL type definitions in it.
      2. Create an [33mapp.ts[39m file.


    --- process.exit(1) ---

    "
  `)
  expect(mockExit).toHaveBeenCalledWith(1)
})

describe('nexusModules', () => {
  it('finds nested nexus modules', async () => {
    ctx.setup({
      'tsconfig.json': tsconfigSource(),
      src: {
        'app.ts': '',
        graphql: {
          '1.ts': `import { schema } from 'nexus'`,
          '2.ts': `import { schema } from 'nexus'`,
          graphql: {
            '3.ts': `import { schema } from 'nexus'`,
            '4.ts': `import { schema } from 'nexus'`,
            graphql: {
              '5.ts': `import { schema } from 'nexus'`,
              '6.ts': `import { schema } from 'nexus'`,
            },
          },
        },
      },
    })

    const result = await ctx.createLayoutThrow()

    expect(result.nexusModules).toMatchInlineSnapshot(`
          Array [
            "__DYNAMIC__/src/graphql/1.ts",
            "__DYNAMIC__/src/graphql/2.ts",
            "__DYNAMIC__/src/graphql/graphql/3.ts",
            "__DYNAMIC__/src/graphql/graphql/4.ts",
            "__DYNAMIC__/src/graphql/graphql/graphql/5.ts",
            "__DYNAMIC__/src/graphql/graphql/graphql/6.ts",
          ]
      `)
  })

  it('does not take custom entrypoint as nexus module if contains a nexus import', async () => {
    await ctx.setup({
      'tsconfig.json': tsconfigSource(),
      'app.ts': `import { schema } from 'nexus'`,
      'graphql.ts': `import { schema } from 'nexus'`,
    })
    const result = await ctx.createLayoutThrow({ entrypointPath: './app.ts' })
    expect({
      app: result.app,
      nexusModules: result.nexusModules,
    }).toMatchInlineSnapshot(`
          Object {
            "app": Object {
              "exists": true,
              "path": "__DYNAMIC__/app.ts",
            },
            "nexusModules": Array [
              "__DYNAMIC__/graphql.ts",
            ],
          }
      `)
  })
})

describe('packageManagerType', () => {
  it('detects yarn as package manager', async () => {
    ctx.setup({ 'tsconfig.json': tsconfigSource(), 'app.ts': '', 'yarn.lock': '' })
    const result = await ctx.createLayoutThrow()
    expect(result.packageManagerType).toMatchInlineSnapshot(`"yarn"`)
  })
})

describe('entrypoint', () => {
  it('finds app.ts entrypoint', async () => {
    ctx.setup({ 'tsconfig.json': tsconfigSource(), 'app.ts': '' })
    const result = await ctx.createLayoutThrow()
    expect(result.app).toMatchInlineSnapshot(`
          Object {
            "exists": true,
            "path": "__DYNAMIC__/app.ts",
          }
      `)
  })

  it('set app.exists = false if no entrypoint', async () => {
    await ctx.setup({ 'tsconfig.json': tsconfigSource(), 'graphql.ts': '' })
    const result = await ctx.createLayoutThrow()
    expect(result.app).toMatchInlineSnapshot(`
          Object {
            "exists": false,
            "path": null,
          }
      `)
  })

  it('uses custom relative entrypoint when defined', async () => {
    await ctx.setup({ 'tsconfig.json': tsconfigSource(), 'index.ts': `console.log('entrypoint')` })
    const result = await ctx.createLayoutThrow({ entrypointPath: './index.ts' })
    expect(result.app).toMatchInlineSnapshot(`
          Object {
            "exists": true,
            "path": "__DYNAMIC__/index.ts",
          }
      `)
  })

  it('uses custom absolute entrypoint when defined', async () => {
    await ctx.setup({ 'tsconfig.json': tsconfigSource(), 'index.ts': `console.log('entrypoint')` })
    const result = await ctx.createLayoutThrow({ entrypointPath: ctx.fs.path('index.ts') })
    expect(result.app).toMatchInlineSnapshot(`
          Object {
            "exists": true,
            "path": "__DYNAMIC__/index.ts",
          }
      `)
  })

  it('fails if custom entrypoint does not exist', async () => {
    await ctx.setup({ 'tsconfig.json': tsconfigSource(), 'index.ts': `console.log('entrypoint')` })
    const result = await ctx.createLayout({ entrypointPath: './wrong-path.ts' })
    expect(JSON.stringify(result)).toMatchInlineSnapshot(
      `"{\\"_tag\\":\\"Left\\",\\"left\\":{\\"message\\":\\"Entrypoint does not exist\\",\\"context\\":{\\"path\\":\\"__DYNAMIC__/wrong-path.ts\\"},\\"type\\":\\"generic\\"}}"`
    )
  })

  it('fails if custom entrypoint is not a .ts file', async () => {
    await ctx.setup({
      'tsconfig.json': tsconfigSource(),
      'index.ts': ``,
      'index.js': `console.log('entrypoint')`,
    })
    const result = await ctx.createLayout({ entrypointPath: './index.js' })
    expect(JSON.stringify(result)).toMatchInlineSnapshot(
      `"{\\"_tag\\":\\"Left\\",\\"left\\":{\\"message\\":\\"Entrypoint must be a .ts file\\",\\"context\\":{\\"path\\":\\"__DYNAMIC__/index.js\\"},\\"type\\":\\"generic\\"}}"`
    )
  })
})

describe('build', () => {
  it(`defaults to .nexus/build`, async () => {
    await ctx.setup({ 'tsconfig.json': tsconfigSource(), 'graphql.ts': '' })
    const result = await ctx.createLayoutThrow()

    expect({
      tsOutputDir: result.build.tsOutputDir,
      startModuleInPath: result.build.startModuleInPath,
      startModuleOutPath: result.build.startModuleOutPath,
    }).toMatchInlineSnapshot(`
      Object {
        "startModuleInPath": "__DYNAMIC__/index.ts",
        "startModuleOutPath": "__DYNAMIC__/.nexus/build/index.js",
        "tsOutputDir": "__DYNAMIC__/.nexus/build",
      }
    `)
  })

  it(`use tsconfig.json outDir is no custom output is used`, async () => {
    await ctx.setup({
      'tsconfig.json': tsconfigSource({
        compilerOptions: {
          outDir: 'dist',
        },
      }),
      'graphql.ts': '',
    })
    const result = await ctx.createLayoutThrow()

    expect({
      tsOutputDir: result.build.tsOutputDir,
      startModuleInPath: result.build.startModuleInPath,
      startModuleOutPath: result.build.startModuleOutPath,
    }).toMatchInlineSnapshot(`
      Object {
        "startModuleInPath": "__DYNAMIC__/index.ts",
        "startModuleOutPath": "__DYNAMIC__/dist/index.js",
        "tsOutputDir": "__DYNAMIC__/dist",
      }
    `)
  })
  it(`override tsconfig.json outDir is a custom output is used`, async () => {
    await ctx.setup({
      'tsconfig.json': tsconfigSource({
        compilerOptions: {
          outDir: 'dist',
        },
      }),
      'graphql.ts': '',
    })
    const result = await ctx.createLayoutThrow({ buildOutput: 'custom-output' })

    expect({
      tsOutputDir: result.build.tsOutputDir,
      startModuleInPath: result.build.startModuleInPath,
      startModuleOutPath: result.build.startModuleOutPath,
    }).toMatchInlineSnapshot(`
      Object {
        "startModuleInPath": "__DYNAMIC__/index.ts",
        "startModuleOutPath": "__DYNAMIC__/custom-output/index.js",
        "tsOutputDir": "__DYNAMIC__/custom-output",
      }
    `)
  })
})

describe('scanProjectType', () => {
  const pjdata = { version: '0.0.0', name: 'foo' }

  describe('if package.json with nexus dep then nexus project', () => {
    it('in cwd', async () => {
      ctx.fs.write('package.json', { ...pjdata, dependencies: { nexus: '0.0.0' } })
      const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
      expect(res.type).toMatchInlineSnapshot(`"NEXUS_project"`)
    })
    it('in hierarchy', async () => {
      nestTmpDir()
      ctx.fs.write('../package.json', { ...pjdata, dependencies: { nexus: '0.0.0' } })
      const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
      expect(res.type).toMatchInlineSnapshot(`"NEXUS_project"`)
    })
  })

  describe('if package.json without nexus dep then node project', () => {
    it('in cwd', async () => {
      ctx.fs.write('package.json', { ...pjdata, dependencies: {} })
      const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
      expect(res.type).toMatchInlineSnapshot(`"node_project"`)
    })
    it('in hierarchy', async () => {
      nestTmpDir()
      ctx.fs.write('../package.json', { ...pjdata, dependencies: {} })
      const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
      expect(res.type).toMatchInlineSnapshot(`"node_project"`)
    })
  })

  it('if no package.json and dir is empty then new project', async () => {
    const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
    expect(res.type).toMatchInlineSnapshot(`"new"`)
  })
  it('if no package.json and dir is not empty then unknown project', async () => {
    ctx.fs.write('foo.txt', 'bar')
    const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
    expect(res.type).toMatchInlineSnapshot(`"unknown"`)
  })
  describe('if malformed package.json then error', () => {
    it('in cwd', async () => {
      ctx.fs.write('package.json', 'bad')
      const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
      expect(res.type).toMatchInlineSnapshot(`"malformed_package_json"`)
    })
    it('in hierarchy', async () => {
      nestTmpDir()
      ctx.fs.write('../package.json', 'bad')
      const res = await Layout.scanProjectType({ cwd: ctx.fs.cwd() })
      expect(res.type).toMatchInlineSnapshot(`"malformed_package_json"`)
    })
  })
})
