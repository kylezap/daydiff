import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import config from '../../config/default.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const PLIST_LABEL = 'com.daydiff.daily';

/**
 * Generate the launchd plist XML content.
 */
function generatePlist() {
  const nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
  const cliPath = resolve(ROOT_DIR, 'src/cli.mjs');
  const logDir = resolve(config.dataDir, 'logs');
  const envPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliPath}</string>
        <string>run</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${config.schedule.hour}</integer>
        <key>Minute</key>
        <integer>${config.schedule.minute}</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${logDir}/daydiff-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${logDir}/daydiff-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${envPath}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>Nice</key>
    <integer>10</integer>
</dict>
</plist>
`;
}

/**
 * Install the launchd plist and load it.
 */
export function installLaunchd() {
  const launchAgentsDir = resolve(homedir(), 'Library/LaunchAgents');
  const plistPath = resolve(launchAgentsDir, `${PLIST_LABEL}.plist`);
  const logDir = resolve(config.dataDir, 'logs');

  console.log('\n═══════════════════════════════════════════');
  console.log('  DayDiff — Install Daily Schedule');
  console.log('═══════════════════════════════════════════\n');

  // Ensure log directory exists
  mkdirSync(logDir, { recursive: true });

  // Unload existing if present
  if (existsSync(plistPath)) {
    console.log('[schedule] Unloading existing job...');
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch {
      // May not be loaded
    }
  }

  // Write plist
  const plistContent = generatePlist();
  writeFileSync(plistPath, plistContent, 'utf-8');
  console.log(`[schedule] Plist written to: ${plistPath}`);

  // Load the job
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
    console.log('[schedule] Job loaded successfully');
  } catch (err) {
    console.error(`[schedule] Failed to load job: ${err.message}`);
    console.log('[schedule] You may need to load it manually:');
    console.log(`           launchctl load "${plistPath}"`);
  }

  console.log(`\n[schedule] Daily run configured at ${config.schedule.hour}:${String(config.schedule.minute).padStart(2, '0')}`);
  console.log(`[schedule] Logs: ${logDir}/`);
  console.log('\n[schedule] To unload:');
  console.log(`           launchctl unload "${plistPath}"`);
  console.log('═══════════════════════════════════════════\n');
}
