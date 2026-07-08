const fs = require('fs');

const configContent = import { Command } from 'commander'
import * as readline from 'readline'
import { readConfig, writeConfig } from '../config'

function prompt(question: string, defaultVal: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.on('error', () => { rl.close(); resolve(defaultVal) })
    rl.question(\\ (\): \, answer => {
      rl.close()
      resolve(answer.trim() || defaultVal)
    })
  })
}

export function registerConfigCommand(program: Command): void {
  const config = program.command('config')

  config
    .command('init')
    .description('Initialize nblm-putter configuration')
    .action(async () => {
      const current = readConfig()
      const region = await prompt('AWS region', current.aws.region)
      const profile = await prompt('AWS profile', current.aws.profile)
      const smInput = await prompt('Use Secrets Manager for cross-machine sync? (y/n)', current.useSecretsManager ? 'y' : 'n')
      
      // Proxy configuration
      console.log('\\n--- Proxy Configuration (Optional) ---')
      const useProxy = await prompt('Use proxy? (y/n)', current.proxy ? 'y' : 'n')
      let proxy = current.proxy
      if (useProxy.toLowerCase() === 'y') {
        const server = await prompt('Proxy server (e.g., http://127.0.0.1:7890)', current.proxy?.server || 'http://127.0.0.1:7890')
        const username = await prompt('Proxy username (leave empty if no auth)', current.proxy?.username || '')
        const password = await prompt('Proxy password (leave empty if no auth)', current.proxy?.password || '')
        proxy = { 
          server, 
          username: username || undefined, 
          password: password || undefined 
        }
      } else {
        proxy = undefined
      }
      
      const clientId = await prompt('Google Cloud OAuth2 Client ID (for Drive sync, Enter to skip)', current.drive.clientId)
      const clientSecret = await prompt('Google Cloud OAuth2 Client Secret (for Drive sync, Enter to skip)', current.drive.clientSecret)
      
      writeConfig({
        useSecretsManager: smInput.toLowerCase() === 'y',
        aws: { region, profile },
        drive: { clientId, clientSecret },
        proxy,
      })
      console.log('✓ Configuration saved.')
    })
}
;

fs.writeFileSync('C:/github/nblm-putter/packages/cli/src/commands/config.ts', configContent, 'utf8');
console.log('✓ config.ts written successfully');
