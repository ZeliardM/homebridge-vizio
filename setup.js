'use strict';

const readline = require('node:readline');
const VizioClient = require('./lib/vizio-client');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

main()
  .catch((error) => {
    console.error(`Pairing failed: ${error.message || error}`);
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });

async function main() {
  const address = await question('Enter the IP address or hostname of your display: ');
  const display = new VizioClient(address);

  await display.pairing.initiate('Homebridge Vizio');
  const pin = await question('Enter the PIN shown on your display: ');
  const response = await display.pairing.pair(pin);

  console.log('Your display is paired.');
  console.log(`Access token: ${response.ITEM.AUTH_TOKEN}`);
}

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}
