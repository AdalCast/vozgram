import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // GramJS toca `global` en varios lugares; en el navegador es `globalThis`.
  define: { global: 'globalThis' },

  resolve: {
    alias: {
      // --- EL ALIAS QUE IMPORTA ------------------------------------------
      // GramJS YA trae su criptografia de navegador en crypto/crypto.js
      // (randomBytes, createCipheriv, createHash, pbkdf2Sync sobre WebCrypto).
      // Pero CryptoFile.js hace `require('crypto')` a secas, esperando que el
      // empaquetador lo redirija -- es el contrato que usan sus propios
      // bundles. Sin esta linea el proyecto COMPILA LIMPIO y truena al primer
      // byte aleatorio con `randomBytes is not a function`.
      crypto: r('./node_modules/telegram/crypto/crypto.js'),

      // Modulos de Node que GramJS importa. Ver stubs/ para el detalle.
      util: r('./stubs/util.ts'),
      os: r('./stubs/os.ts'),
      path: r('./stubs/path.ts'),
      events: r('./stubs/events.ts'),
      fs: r('./stubs/vacio.ts'),
      net: r('./stubs/vacio.ts'),
      stream: r('./stubs/vacio.ts'),
      assert: r('./stubs/vacio.ts'),
      constants: r('./stubs/vacio.ts'),

      // --- CODIGO COMPARTIDO CON LA APP PRIVADA ---------------------------
      // ui.ts es dibujo puro: no conoce proveedores, ni backend, ni WhatsApp.
      // Se comparte en vez de copiarse para que el diseño tenga UNA sola casa.
      // Arrastra glasses/src/config.ts (de donde saca SCREEN_W/SCREEN_H); sus
      // otras constantes no se usan aqui y el tree-shaking las tira.
      '@ui': r('../glasses/src/ui.ts'),
    },
  },

  server: { fs: { allow: ['..'] } },   // deja leer ../glasses/src en desarrollo
  build: { target: 'es2020' },
})
