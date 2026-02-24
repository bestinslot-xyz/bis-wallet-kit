import { Project, SyntaxKind, VariableDeclarationKind } from 'ts-morph'

// your tsconfig for ESLint/type info
const project = new Project({
  tsConfigFilePath: 'tsconfig.eslint.json',
})

// helper: to PascalCase (for interfaces)
function toPascalCase(name: string) {
  const camel = name.replace(/_([a-z0-9])/gi, (_, c) => c.toUpperCase())
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

// helper: snake_case → camelCase
function toCamelCase(name: string) {
  if (name.startsWith('_')) {
    const camel = name.slice(1).replace(/_([a-z0-9])/gi, (_, c) => c.toUpperCase())
    return `_${camel}`
  } else {
    return name.replace(/_([a-z0-9])/gi, (_, c) => c.toUpperCase())
  }
}

// helper: camelCase → UPPER_SNAKE_CASE (for top-level consts)
function toUpperSnakeCase(name: string) {
  if (name.startsWith('_')) {
    const upperSnake = name
      .slice(1)
      .replace(/([a-z])([A-Z])/g, '$1_$2') // camelCase → snake_case
      .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2') // handle consecutive capitals (e.g. "HTTPServer" → "HTTP_SERVER")
      .toUpperCase()
    return `_${upperSnake}`
  }
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2') // camelCase → snake_case
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2') // handle consecutive capitals (e.g. "HTTPServer" → "HTTP_SERVER")
    .toUpperCase()
}

function processFunction(fn: any) {
  if (fn.getName) {
    // not all functions have names (e.g. arrow functions)
    const name = fn.getName()
    const camel = toCamelCase(name || '')
    if (name && camel !== name) fn.rename(camel)
  }

  // Function parameters
  fn.getParameters().forEach((param: any) => {
    const name = param.getName()
    const camel = toCamelCase(name)
    if (camel !== name) param.rename(camel)
  })

  fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((v: any) => {
    const name = v.getName()
    const camel = toCamelCase(name)
    try {
      if (camel !== name) v.rename(camel)
    } catch {
      // ignore rename errors
    }
  })

  fn.getDescendantsOfKind(SyntaxKind.ArrowFunction).forEach((arrowFn: any) => {
    processFunction(arrowFn)
  })

  fn.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).forEach((nestedFn: any) => {
    processFunction(nestedFn)
  })
}

project.getSourceFiles().forEach(file => {
  if (file.getFilePath().includes('node_modules')) return

  // Expand shorthand in object literals to preserve original key (eslint will automatically fix this back to shorthand after camelCase conversion)
  file.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression).forEach(obj => {
    obj.getProperties().forEach(prop => {
      if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        const name = prop.getName()
        prop.replaceWithText(`${name}: ${name}`)
      }
    })
  })

  // Variables (non-function, non-class)
  file.getVariableDeclarations().forEach(v => {
    const name = v.getName()
    const parent = v.getFirstAncestorByKind(SyntaxKind.VariableStatement)
    if (!parent) return

    const initializer = v.getInitializer()
    const isTopLevelConst =
      parent.getDeclarationList().getDeclarationKind() === VariableDeclarationKind.Const &&
      parent.getParentOrThrow().getKind() === SyntaxKind.SourceFile

    const isExported =
      initializer?.getKind() === SyntaxKind.ObjectLiteralExpression ||
      parent.getFirstAncestorByKind(SyntaxKind.ExportKeyword)

    // skip top-level consts and top-level exported objects
    if (isTopLevelConst) {
      if (isExported) {
        return
      }
      const upperSnake = toUpperSnakeCase(name)
      if (upperSnake !== name) v.rename(upperSnake)
      return
    }

    // rename binding
    const camel = toCamelCase(name)
    if (camel !== name) v.rename(camel)
  })

  file.getInterfaces().forEach(intf => {
    // Interface properties
    const name = intf.getName()
    const camel = toCamelCase(name)
    if (camel !== name) intf.rename(camel)
  })

  // Functions
  file.getFunctions().forEach(fn => {
    processFunction(fn)
  })

  // Arrow functions
  file.getDescendantsOfKind(SyntaxKind.ArrowFunction).forEach(fn => {
    processFunction(fn)
  })

  // Class properties
  file.getClasses().forEach(cls => {
    const name = cls.getName()
    const camel = toPascalCase(name || '')
    if (name && camel !== name) cls.rename(camel)

    cls.getProperties().forEach(prop => {
      const name = prop.getName()
      const camel = toCamelCase(name)
      if (camel !== name) prop.rename(camel)
    })

    cls.getConstructors().forEach(ctor => {
      ctor.getParameters().forEach(param => {
        const name = param.getName()
        const camel = toCamelCase(name)
        if (camel !== name) param.rename(camel)
      })
    })

    // Class methods
    cls.getMethods().forEach(method => {
      processFunction(method)
    })
  })
})

project.save().then(() => console.log('Conversion complete, run lint:fix, compile and test'))
