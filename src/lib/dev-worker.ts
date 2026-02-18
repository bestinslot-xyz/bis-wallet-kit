import wrapper from 'solc/wrapper'

let compiler: any = null

globalThis.addEventListener('message', async (e) => {
  const { compilerVersion, sourceCode } = e.data

  if (!compiler) {
    const response = await fetch(`https://binaries.soliditylang.org/bin/${compilerVersion}`)
    const jsCode = await response.text()

    const Module: any = {
      onRuntimeInitialized() {
        const wrapped = wrapper(Module)
        compiler = wrapped

        const output = JSON.parse(compiler.compile(JSON.stringify(sourceCode)))
        globalThis.postMessage({ output })
      },
    }

    // Inject the existing Module into the compiler context
    const wrappedCode = `(function(Module) { ${jsCode}; return Module; })`

    // eslint-disable-next-line no-new-func
    const runCompiler = new Function('Module', `return ${wrappedCode}`)()
    runCompiler(Module)
  }
  else {
    const output = JSON.parse(compiler.compile(JSON.stringify(sourceCode)))
    globalThis.postMessage({ output })
  }
})
