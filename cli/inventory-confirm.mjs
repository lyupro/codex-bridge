/** Lets the operator declare a shared home's installation inventory complete, the one statement the package cannot prove.
 * Plan_67 D11, OW-047: only the operator can account for unrecorded hosts using this home.
 */
import { isFormat2 } from '../src/home/lib/install-owner-roots.mjs';
import { publishInstallRecordOnly, readInstallRecordFile } from './install-record.mjs';
import { validateFormat2 } from './install-owners.mjs';
import { registryHintLines } from './inventory-transition.mjs';
import { withLifecycle } from './lifecycle-transaction.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { askYesNo, isInteractive } from './terminal-question.mjs';

export const INVENTORY_CONFIRM_COMMAND = 'codex-bridge inventory confirm';

const question = 'Are these all the hosts using this home?';
const updateHint = 'Run codex-bridge update to migrate the installation record.';

async function confirmInRun(host, dryRun, questionOptions) {
  let record;
  try {
    record = await readInstallRecordFile(host);
    if (!isFormat2(record)) {
      return { exitCode: 1, output: `No format-2 installation record was found. ${updateHint}` };
    }
    validateFormat2(record);
  } catch (error) {
    return { exitCode: 1, output: `Invalid installation record: ${error.message} ${updateHint}` };
  }
  const owners = Object.values(record.owners);
  if (owners.length === 0) {
    return { exitCode: 1, output: 'no recorded owners; install into each host first' };
  }
  if (record.inventory === 'complete' && !Object.hasOwn(record, 'legacy')) {
    return { exitCode: 0, output: 'The inventory is already complete.' };
  }

  const screen = [
    `Home: ${host.brandRoot}`,
    'Recorded hosts:',
    ...owners.map((owner) => `  ${owner.root}`),
    ...registryHintLines(host, (await readRulesRegistry(host))?.owners ?? []),
    "Confirming lets the last recorded host's uninstall remove the shared image. "
      + 'A host that uses this home but is not listed must be enrolled first: '
      + 'codex-bridge install --host "<path>".',
  ].join('\n');
  if (dryRun) return { exitCode: 0, output: `${screen}\nDry run: nothing changed.` };
  const prompt = `${screen}\n${question}`;
  if (!isInteractive(questionOptions)) {
    return { exitCode: 1, output: `${prompt}\nRun this command in a terminal to answer.` };
  }
  const answer = await askYesNo(prompt, questionOptions);
  if (answer === 'cancel') {
    return { exitCode: 130, output: `${prompt}\nCancelled; nothing was changed.` };
  }
  if (answer !== 'yes') {
    return { exitCode: 1, output: `${prompt}\nNothing changed: the inventory stays incomplete.` };
  }

  // A4 pre-mortem: the raw fields are evidence of lag, not material to regenerate on confirmation.
  const next = { ...record, inventory: 'complete' };
  delete next.legacy;
  await publishInstallRecordOnly(host, next);
  return { exitCode: 0, output: `${prompt}\nRecorded the inventory as complete.` };
}

export async function inventoryConfirm({ host, dryRun = false, ...questionOptions }) {
  const action = (ticket) => {
    // Plan_67 R2: a first install may create the home after the unlocked missing-home check.
    if (!dryRun && ticket === undefined) {
      return { exitCode: 1, output: `No format-2 installation record was found. ${updateHint}` };
    }
    return confirmInRun(host, dryRun, questionOptions);
  };
  // Plan_67 D11: dry-run only reads; a real declaration holds the lifecycle lock before reading.
  return dryRun ? action() : withLifecycle(host, 'inventory', action);
}
