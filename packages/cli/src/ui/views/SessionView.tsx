import { Box, Text } from "ink";
import type { CheckSessionSnapshot } from "@coldtea/abide-schema";
import { Header } from "../components/Header.js";
import { Section } from "../components/Section.js";
import { glyph, palette } from "../theme.js";

export function SessionView({ sessions }: { sessions: CheckSessionSnapshot[] }) {
  return (
    <Box flexDirection="column">
      <Header command="session" where="this machine" />
      <Section title="Check sessions" aside={`${sessions.length}`}>
        {sessions.length === 0 ? (
          <Text color={palette.ash}>
            No check sessions yet. A hook starts one on the first check.
          </Text>
        ) : (
          sessions.map((session) => (
            <Box key={session.sessionId} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={session.conflict ? palette.rose : palette.mist}>
                  {session.sessionId.slice(0, 24)}
                </Text>
                <Text color={palette.ash}>
                  {"  "}
                  rules {session.ruleFingerprint.slice(0, 10)} ({session.rules.length})
                </Text>
              </Box>
              <Text color={session.conflict ? palette.rose : palette.ash}>
                {session.conflict
                  ? `${glyph.cross} ${session.conflict.kind} drift ${glyph.dotSep} abide session rebase ${session.sessionId}`
                  : `${glyph.check} in step with its snapshot`}
              </Text>
            </Box>
          ))
        )}
      </Section>
    </Box>
  );
}
