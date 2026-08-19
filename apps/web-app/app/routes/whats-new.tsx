import { useEffect } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion.js";
import { track } from "~/lib/analytics.js";
import { changelogSource, parseChangelog } from "~/lib/changelog.js";
import { useAppSession } from "~/lib/session.js";

const sections = parseChangelog(changelogSource);

/** Protected What's New archive — formatted CHANGELOG.md, not a launch popup. */
export default function WhatsNew() {
  const session = useAppSession();
  const latestVersion = sections[0]?.version;

  useEffect(() => {
    if (session.state !== "ready" || !latestVersion) {
      return;
    }
    track("whats_new_opened", { latestVersion });
  }, [latestVersion, session.state]);

  if (session.state !== "ready") {
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight">What's new</h1>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No released updates yet.</p>
      ) : (
        <Accordion multiple defaultValue={latestVersion ? [latestVersion] : []}>
          {sections.map((section) => (
            <AccordionItem key={section.version} value={section.version}>
              <AccordionTrigger>
                {section.version} · {section.date}
              </AccordionTrigger>
              <AccordionContent className="space-y-4">
                {section.intro.map((paragraph) => (
                  <p
                    key={`${section.version}-intro-${paragraph}`}
                    className="text-muted-foreground"
                  >
                    {paragraph}
                  </p>
                ))}
                {section.categories.map((category) => (
                  <div key={`${section.version}-${category.heading}`} className="space-y-2">
                    <h3 className="text-sm font-medium">{category.heading}</h3>
                    <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
                      {category.items.map((item) => (
                        <li key={`${section.version}-${category.heading}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}
