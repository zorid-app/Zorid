import path from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
export default {
 root:directory,base:'./',publicDir:false,
 define:{__ZORID_CORE_FIXTURES__:'false',__ZORID_CORE_BUILD_ID__:'""',__ZORID_CORE_MODULE_PATH__:'""'},
 build:{target:'es2022',outDir:process.env.ZORID_EDITOR_FLOOR_RENDERER_OUT,emptyOutDir:true,sourcemap:true,
  commonjsOptions:{include:[/node_modules/,/desktop\/.*\.cjs$/]},},
};
