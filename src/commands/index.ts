/** Registers every command module. */
import.meta.glob(['./*.ts', '!./index.ts', '!./registry.ts'], { eager: true });
export { def, getCommand, allCommands, commandCount, searchCommands } from './registry';
