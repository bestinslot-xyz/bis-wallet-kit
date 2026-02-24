import wrapper from 'solc/wrapper'

let compiler: any = null

globalThis.addEventListener('message', async (e) => {
  const { compilerVersion, sourceCode } = e.data

  if (!compiler) {
    const response = await fetch(`https://binaries.soliditylang.org/bin/${compilerVersion}`)
    const jsCode = await response.text()

    const module: any = {
      onRuntimeInitialized() {
        const wrapped = wrapper(module)
        compiler = wrapped

        const output = JSON.parse(compiler.compile(JSON.stringify(sourceCode)))
        globalThis.postMessage({ output })
      },
    }

    // Inject the existing module into the compiler context
    const wrappedCode = `(function(module) { ${jsCode}; return module; })`

    // eslint-disable-next-line no-new-func
    const runCompiler = new Function('module', `return ${wrappedCode}`)()
    runCompiler(module)
  }
  else {
    const output = JSON.parse(compiler.compile(JSON.stringify(sourceCode)))
    globalThis.postMessage({ output })
  }
})
