<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from './Button.vue'
import Input from './Input.vue'
import Label from './Label.vue'
import Select from './Select.vue'

const parsedJson = ref<string>()
const version = ref('v0.8.28+commit.7893614a')
const versionOptions = ref([
  { value: 'v0.8.28+commit.7893614a', label: 'v0.8.28+commit.7893614a' },
])
const compileOutput = ref<{ sources: any, contracts: any }>()
let CompilerWorker: Worker | null = null
const contractList = ref<{ file: string, contract: string }[]>([])
const contractSelectModel = ref<string>() // fName___ cName
initWorker()

const contractOptions = computed(() => {
  return contractList.value.map(contract => ({
    value: `${contract.file}___${contract.contract}`,
    label: `${contract.file}/${contract.contract}`,
  }))
})

const contract = computed(() => {
  const selectedContract = contractSelectModel.value?.split('___')
  if (selectedContract && selectedContract.length === 2) {
    const fName = selectedContract[0]!
    const cName = selectedContract[1]!
    const item = compileOutput.value?.contracts[fName][cName]

    console.log(item)

    return item
  }
  return null
})

async function onCompile(output: any) {
  console.log('Compiled output:', output)

  compileOutput.value = output

  for (const contractFileName in output.contracts) {
    for (const contractName in output.contracts[contractFileName]) {
      // console.log(`Bytecode of contract: ${contractName} in file ${contractFileName}: ${output.contracts[contractFileName][contractName].evm.bytecode.object}`)
      const temp = {
        file: contractFileName,
        contract: contractName,
      }

      contractList.value.push(temp)
    }
  }

  console.log('Contract list:', contractList.value)
}

async function onJSONFileChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file)
    return

  if (file.type !== 'application/json') {
    console.error('Please upload a valid JSON file.')
    return
  }

  try {
    const jsonData = await parseJSONFile(file)
    console.log('Parsed JSON data:', jsonData)
    // console.log(jsonData.settings.compilationTarget['BRC20_Controller.sol'])

    parsedJson.value = jsonData
  }
  catch (error) {
    console.error('Error parsing JSON file:', error)
  }
}

async function parseJSONFile(file: File): Promise<any> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      try {
        const jsonData = JSON.parse(reader.result as string)
        resolve(jsonData)
      }
      catch (error) {
        reject(error)
      }
    }

    reader.onerror = () => {
      reject(reader.error)
    }

    reader.readAsText(file)
  })
}

function compile() {
  // Convert from "ref" to "string"
  const plainJson = JSON.parse(JSON.stringify(parsedJson.value))

  CompilerWorker?.postMessage({
    sourceCode: plainJson,
    compilerVersion: 'soljson-v0.8.28+commit.7893614a.js',
  })
}

function initWorker() {
  if (CompilerWorker)
    return

  CompilerWorker = new Worker(new URL('@@/lib/dev-worker.ts', import.meta.url), {
    type: 'module',
  })

  CompilerWorker.onmessage = (e) => {
    onCompile(e.data.output)
  }
}
</script>

<template>
  <div>
    <h2 class="text-xl font-bold mb-4">
      BRC20
    </h2>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <Label>JSON File:</Label>
        <Input type="file" accept=".json" @change="onJSONFileChange" />
      </div>
      <div>
        <Label>Version:</Label>
        <Select v-model="version" :options="versionOptions" class="w-full" />
      </div>
      <div class="col-span-2">
        <Button @click="compile">
          Compile
        </Button>
      </div>
      <template v-if="contractOptions.length > 0">
        <div>
          <Label>Contract:</Label>
          <Select v-model="contractSelectModel" :options="contractOptions" class="w-full" />
        </div>
        <div class="text-sm">
          {{ contract }}
        </div>
      </template>
    </div>
  </div>
</template>
