// A fake agent for testing AgentsCircle without real AI calls.
// Reads the prompt from stdin and streams back a short reply.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const last = input.split('### NEW MESSAGE FOR YOU')[1] || input;
  const lines = [
    `Mock agent here. I received ${input.length} characters of shared context.`,
    `Your request was: ${last.trim().split('\n').slice(-1)[0]}`,
    `Working folder: ${process.cwd()}`,
  ];
  for (const l of lines) {
    process.stdout.write(l + '\n');
    await new Promise((r) => setTimeout(r, 250));
  }
});
