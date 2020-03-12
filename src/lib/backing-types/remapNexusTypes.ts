import * as NexusSchema from '@nexus/schema'
import * as Schema from '../../framework/schema'
import { rootLogger } from '../../utils/logger'
import { BackingTypes } from './extract'

const log = rootLogger.child('backing-types')

export function remapNexusTypesWithBackingTypes(
  types: Schema.AllNexusTypeDefs[],
  backingTypes: BackingTypes
) {
  return types.map(t => {
    if (
      NexusSchema.core.isNexusObjectTypeDef(t) ||
      NexusSchema.core.isNexusInterfaceTypeDef(t) ||
      NexusSchema.core.isNexusUnionTypeDef(t) ||
      NexusSchema.core.isNexusScalarTypeDef(t) ||
      NexusSchema.core.isNexusEnumTypeDef(t)
    ) {
      if (typeof t.value.rootTyping === 'string') {
        const filePath = backingTypes[t.value.rootTyping]

        if (t.value.rootTyping.length === 0) {
          return t
        }

        if (!filePath) {
          log.warn(
            `We could not find the backing type '${t.value.rootTyping}' used in '${t.name}'`
          )
          return t
        }

        t.value.rootTyping = {
          name: t.value.rootTyping,
          path: filePath,
        }
      }
    }

    return t
  })
}
