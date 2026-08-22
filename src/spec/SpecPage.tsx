/**
 * Progress against docs/SPEC.md, rendered from src/spec/progress.ts.
 *
 * Everything here is a view over that data. Nothing on this page states a fact
 * that is not also under test — see tests/progress.test.ts, which refuses a
 * milestone marked done with unfinished tasks, an answered question without
 * evidence, and a decision that has drifted from docs/DECISIONS.md.
 */
import {
  DECISIONS,
  DEPRECATIONS,
  MILESTONES,
  OPEN_QUESTIONS,
  questionTotals,
  taskTotals,
  type Milestone,
  type OpenQuestion,
  type Status,
} from './progress.ts';
import { navigate } from '../ui/useHashRoute.ts';

/**
 * Render `backticks` as inline code.
 *
 * Decision titles are stored verbatim so tests can match them against the
 * headings in docs/DECISIONS.md, which means they arrive carrying markdown.
 * Formatting at render time keeps the data the single source of truth rather
 * than maintaining a second, prettier copy.
 */
function ticks(text: string) {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
  );
}

const STATUS_LABEL: Record<Status, string> = {
  done: 'done',
  active: 'in progress',
  todo: 'not started',
};

function StatusChip({ status }: { status: Status }) {
  return <span className={`chip chip--${status}`}>{STATUS_LABEL[status]}</span>;
}

function TaskRow({ title, status, note }: { title: string; status: Status; note?: string }) {
  return (
    <li className={`task task--${status}`}>
      <span className="task__box" aria-hidden="true">
        {status === 'done' ? '✓' : status === 'active' ? '▸' : ''}
      </span>
      <span className="task__body">
        <span className="task__title">{title}</span>
        {note && <span className="task__note">{note}</span>}
      </span>
    </li>
  );
}

function MilestoneCard({ milestone }: { milestone: Milestone }) {
  const done = milestone.tasks.filter((t) => t.status === 'done').length;

  return (
    <section className={`milestone milestone--${milestone.status}`}>
      <header className="milestone__head">
        <h3 className="milestone__title">{milestone.title}</h3>
        <StatusChip status={milestone.status} />
      </header>
      <p className="milestone__goal">{milestone.goal}</p>

      <div className="milestone__bar" role="presentation">
        <div
          className="milestone__fill"
          style={{ width: `${(done / milestone.tasks.length) * 100}%` }}
        />
      </div>
      <p className="milestone__count mono">
        {done} / {milestone.tasks.length} tasks
      </p>

      <ul className="tasks">
        {milestone.tasks.map((task) => (
          <TaskRow key={task.title} {...task} />
        ))}
      </ul>

      <div className={`exit ${milestone.exitMet ? 'exit--met' : ''}`}>
        <span className="exit__label mono">
          {milestone.exitMet ? '✓ EXIT CRITERION MET' : 'EXIT CRITERION'}
        </span>
        <p className="exit__text">{milestone.exitCriterion}</p>
      </div>
    </section>
  );
}

function QuestionRow({ q }: { q: OpenQuestion }) {
  const state = !q.answer ? 'open' : q.partial ? 'partial' : 'answered';
  return (
    <li className={`question question--${state}`}>
      <div className="question__head">
        <span className="question__num mono">#{q.number}</span>
        <span className="question__text">{q.question}</span>
      </div>
      {q.answer ? (
        <div className="question__answer">
          <p className="question__verdict">
            {q.partial && <span className="chip chip--partial">provisional</span>} {q.answer}
          </p>
          <p className="question__evidence">{q.evidence}</p>
        </div>
      ) : (
        <p className="question__pending">Still open — to be learned by prototyping.</p>
      )}
    </li>
  );
}

export default function SpecPage() {
  const tasks = taskTotals();
  const questions = questionTotals();

  return (
    <div className="spec">
      <div className="spec__inner">
        <header className="spec__header">
          <button className="spec__back" onClick={() => navigate('/')}>
            ← Back to the game
          </button>
          <h1 className="spec__title">
            hop<span>//</span>beat — progress
          </h1>
          <p className="spec__sub">
            Measured against <code>docs/SPEC.md</code>. Nothing is marked done here that is
            not also enforced by <code>tests/progress.test.ts</code>.
          </p>

          <div className="scoreboard">
            <div className="scoreboard__cell">
              <span className="scoreboard__num mono">
                {tasks.milestonesDone}/{tasks.milestonesTotal}
              </span>
              <span className="scoreboard__label">milestones</span>
            </div>
            <div className="scoreboard__cell">
              <span className="scoreboard__num mono">
                {tasks.done}/{tasks.total}
              </span>
              <span className="scoreboard__label">tasks</span>
            </div>
            <div className="scoreboard__cell">
              <span className="scoreboard__num mono">
                {questions.answered + questions.partial}/{questions.total}
              </span>
              <span className="scoreboard__label">questions answered</span>
            </div>
            <div className="scoreboard__cell">
              <span className="scoreboard__num mono">{DECISIONS.length}</span>
              <span className="scoreboard__label">decisions logged</span>
            </div>
          </div>
        </header>

        {DEPRECATIONS.length > 0 && (
          <section className="deprecations">
            {DEPRECATIONS.map((d) => (
              <div key={d.subject} className="deprecation">
                <div className="deprecation__head">
                  <span className="chip chip--deprecated">deprecated</span>
                  <h3 className="deprecation__title">{d.subject}</h3>
                  <span className="deprecation__spec mono">{d.specSection}</span>
                </div>
                <p className="deprecation__summary">{d.summary}</p>
                <p className="deprecation__label">Still true:</p>
                <ul className="deprecation__list">
                  {d.stillTrue.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        <h2 className="spec__section">Roadmap</h2>
        <div className="milestones">
          {MILESTONES.map((m) => (
            <MilestoneCard key={m.id} milestone={m} />
          ))}
        </div>

        <h2 className="spec__section">Open questions — §20</h2>
        <p className="spec__lead">
          The spec lists ten things to learn by building rather than by deciding. An answer
          here has to cite what was measured or observed.
        </p>
        <ul className="questions">
          {OPEN_QUESTIONS.map((q) => (
            <QuestionRow key={q.number} q={q} />
          ))}
        </ul>

        <h2 className="spec__section">Decisions</h2>
        <p className="spec__lead">
          Choices made beyond the spec, or that changed it. Full reasoning lives in{' '}
          <code>docs/DECISIONS.md</code>; these summaries are checked against it by test.
        </p>
        <ol className="decisions">
          {DECISIONS.map((d) => (
            <li key={d.number} className="decision">
              <span className="decision__num mono">{d.number}</span>
              <div>
                <h4 className="decision__title">{ticks(d.title)}</h4>
                <p className="decision__summary">{d.summary}</p>
                {d.corrects && <p className="decision__corrects">Corrects: {d.corrects}</p>}
              </div>
            </li>
          ))}
        </ol>

        <footer className="spec__footer">
          MVP 0 is complete and signed off in play. MVP 1 is the current assignment.
        </footer>
      </div>
    </div>
  );
}
