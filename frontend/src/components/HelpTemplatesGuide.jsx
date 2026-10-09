// The Templates part of the Help page: how the page works, then one block
// per section (each with an anchor, e.g. /help#templates-phases — the
// "How it works" link in every Templates section header points here).
// Kept out of pages/Help.jsx because it's long; it's plain JSX so the
// Help search can read its text.
import { Link } from 'react-router-dom';

const L = ({ to, children }) => (
    <Link to={to} className="text-primary hover:underline">
        {children}
    </Link>
);

// A titled sub-block inside a Help section, with its own anchor.
export function HelpSubTopic({ id, title, children }) {
    return (
        <div id={id} className="scroll-mt-20 space-y-2 rounded-lg border bg-muted/20 p-3">
            <h3 className="text-sm font-semibold">{title}</h3>
            {children}
        </div>
    );
}

const list = 'ml-5 list-disc space-y-1';

export const TEMPLATE_GUIDE_TOPICS = [
    { id: 'templates-page', label: 'How the page works' },
    { id: 'templates-phases', label: 'Phase templates' },
    { id: 'templates-statuses', label: 'Statuses' },
    { id: 'templates-priorities', label: 'Priorities' },
    { id: 'templates-project-types', label: 'Project types' },
    { id: 'templates-products', label: 'Products' },
    { id: 'templates-entities', label: 'Entities' },
    { id: 'templates-countries', label: 'Countries' },
    { id: 'templates-business-units', label: 'Business units' },
    { id: 'templates-app-os', label: 'Target OS options' },
    { id: 'templates-app-pos-terminals', label: 'POS terminal types' },
    { id: 'templates-ticket-types', label: 'Ticket types' },
    { id: 'templates-requester-groups', label: 'Requester groups' },
    { id: 'templates-terminals', label: 'Terminals' },
    { id: 'templates-wallboards', label: 'Wallboards' },
];

export const templatesGuideBody = (
    <>
        <p>
            <L to="/templates">Templates</L> holds every option list the app
            offers in its forms. Admins can open it, and so can anyone with the{' '}
            <em>Manage all templates</em> capability. The three Tickets sections
            can only be saved by admins. A change is available in the forms
            straight away. The sections are grouped as{' '}
            <strong>Workflow</strong> (phases, statuses, priorities),{' '}
            <strong>Catalogues</strong> (project types, products, entities,
            countries), <strong>Organization</strong> (business units),{' '}
            <strong>Apps</strong> (release OS and POS terminal types) and{' '}
            <strong>Tickets</strong> (ticket types, requester groups, terminals).
        </p>
        <div className="flex flex-wrap gap-1.5">
            {TEMPLATE_GUIDE_TOPICS.map((t) => (
                <a
                    key={t.id}
                    href={`#${t.id}`}
                    className="rounded-full border bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                    {t.label}
                </a>
            ))}
        </div>

        <HelpSubTopic id="templates-page" title="How the page works">
            <ul className={list}>
                <li>
                    <strong>Left rail</strong>: the five groups, with a row count
                    next to each section. Counts include inactive rows. The{' '}
                    <em>Sections</em> button folds the rail into icons. The page
                    remembers the last section you had open. Only one section is
                    shown at a time; switching sections drops an unsaved edit or
                    search.
                </li>
                <li>
                    <strong>Header</strong>: the count, a search box (it filters
                    as you type), <em>+ Add</em>, a one-line description and a{' '}
                    <em>How it works</em> link back to this page. Statuses and
                    Priorities also have a <em>Project / Task</em> switch.
                </li>
                <li>
                    <strong>Rows</strong>: a drag handle, colour or code, the
                    name, any switches, and a <em>⋯</em> menu (Edit, Move up,
                    Move down, Delete). Inactive rows are dimmed.
                </li>
                <li>
                    <strong>Editing</strong>: click a name (or ⋯ → Edit). Enter
                    saves and Esc cancels. Shift+Enter adds a new line in longer
                    texts. One row can be edited at a time, and new items are
                    added at the end.
                </li>
                <li>
                    <strong>Active switch</strong>: saves immediately. An inactive
                    value disappears from the pickers, but records that already
                    use it keep it.
                </li>
                <li>
                    <strong>Order</strong>: drag a row by its handle, or use Move
                    up / Move down. The order here is the order in the dropdowns.
                    Reordering is paused while you search.
                </li>
                <li>
                    <strong>Delete</strong> asks for confirmation. Products and
                    Entities can't be deleted while a project uses them. For the
                    other lists, existing records keep the old value or lose the
                    link; each section below says which. If a value is too long,
                    saving fails with a message naming the field.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-phases" title="Phase templates">
            <ul className={list}>
                <li>
                    <strong>Fields:</strong> name (up to 60 characters, unique)
                    and colour: <em>Auto</em> or one of sky, emerald, violet,
                    amber, rose, cyan, fuchsia or lime. Click the colour square
                    to change it.
                </li>
                <li>
                    <strong>New project</strong>: every active template is ticked
                    under <em>Project phases</em>, with a <em>Starting phase</em>{' '}
                    picker. The chosen phases are created in this order, with
                    these colours.
                </li>
                <li>
                    <strong>Plan → Add phase → From library</strong> lists the
                    active templates. Phases the project already has are greyed
                    out. <em>Custom name…</em> lets you type any other phase.
                </li>
                <li>
                    <em>Auto</em> gives each phase its own stable colour. Saving a
                    template's colour also recolours phases with the same name in
                    every project. Renaming a template doesn't rename phases that
                    already exist.
                </li>
                <li>
                    A project without phases gets the active templates when it's
                    opened. If no template is active, it gets Kick-off, Planning,
                    Implementation, Review and Closing.
                </li>
                <li>
                    Deleting a template doesn't touch phases already on projects.
                    Reload the page after editing so the New project dialog shows
                    the new list.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-statuses" title="Statuses">
            <ul className={list}>
                <li>
                    <strong>Fields:</strong> a <em>key</em>, set once when you add
                    the status (up to 40 characters, stored in capitals, unique,
                    and it can't be changed later), a <em>label</em> (up to 40)
                    and a colour (slate, sky, emerald, amber, rose or violet).
                </li>
                <li>
                    <strong>Project statuses</strong> are used on the Projects list
                    and cards, the project page and form, Billing and change
                    requests. Renaming a label changes it everywhere at once; Excel
                    exports keep the standard names.
                </li>
                <li>
                    The built-in keys <code>TODO</code>,{' '}
                    <code>IN_PROGRESS</code>, <code>CLIENT_TEST</code>,{' '}
                    <code>BILLING</code>, <code>DONE</code> and{' '}
                    <code>ON_HOLD</code> drive the app's logic (<code>DONE</code>{' '}
                    means complete). Rename, recolour or hide them freely — they
                    are marked with a lock and can't be deleted, and they keep
                    working even while hidden.
                </li>
                <li>
                    A hidden or deleted status disappears from the dropdowns, and
                    projects keep the status they have. If you delete a custom
                    status, a project that still has it must get another status
                    (or you add the status back) before it can be saved again.
                </li>
                <li>
                    <strong>Task</strong> switch: task statuses are a fixed set
                    (To do, In progress, On hold, Done). Rename, recolour or
                    reorder them here and every task picker and badge follows.
                    They can't be hidden, deleted or added to.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-priorities" title="Priorities">
            <ul className={list}>
                <li>
                    Same fields and <em>Project / Task</em> switch as Statuses.
                    The starting lists are Low, Medium, High and Urgent for
                    projects, and Low, Medium and High for tasks.
                </li>
                <li>
                    <strong>Project</strong> priorities appear on the project
                    form, the Projects list and cards, and the project page.{' '}
                    <strong>Task</strong> priorities appear as the coloured stripe
                    and picker on the Plan's task rows and in the task dialog.
                    The quick view and My to-do show the standard names.
                </li>
                <li>
                    Priorities are a fixed set: rename, recolour, reorder or
                    hide the standard ones, but new keys can't be added and the
                    standard ones can't be deleted (they're marked with a lock).
                    A hidden priority disappears from the dropdowns; records
                    that already have it keep showing it.
                </li>
                <li>
                    Rows added earlier with a non-standard key are tagged{' '}
                    <em>Not used</em> — nothing can be saved with them and they
                    aren't offered anywhere, so you can delete them.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-project-types" title="Project types">
            <ul className={list}>
                <li>
                    <strong>Fields:</strong> name (up to 100, unique) and an
                    optional <em>activity code</em> (up to 60, shown as a pill).
                    The <em>Hide complete</em> switch sits on the row.
                </li>
                <li>
                    <strong>Used in:</strong> the project form (a type that's
                    inactive shows as "(inactive)"), the Projects filter and
                    column, Time tracking → Charts "By project type", profile
                    stats, and the time CSV columns <em>Project type</em> and{' '}
                    <em>Activity code</em>.
                </li>
                <li>
                    <strong>Hide complete</strong> is for ongoing work such as
                    support or maintenance. Projects of that type lose the
                    Completed, Client test and Billing statuses. <em>Mark
                    complete</em> and <em>Reopen</em> are hidden, and the project
                    shows an amber pill with the type name. A project already in
                    one of those statuses moves to In progress the next time it's
                    edited.
                </li>
                <li>Deleting a type leaves its projects without a type.</li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-products" title="Products">
            <ul className={list}>
                <li>
                    <strong>Fields:</strong> name (up to 120), optional code (up to
                    60) and description (up to 2000, several lines). The list is
                    sorted by name, so there's no manual ordering.
                </li>
                <li>
                    <strong>Used in:</strong> the project form, shown as "CODE ·
                    Name" (an inactive product stays on the projects that have
                    it). Also the Projects filter, the project page, Time tracking
                    → Charts (product filter and "By product"), and the time CSV
                    columns <em>Product code</em> and <em>Product</em> (
                    <code>NO_PRODUCT</code> when empty).
                </li>
                <li>
                    You can't delete a product while any project uses it.
                    Reassign those projects first, or set the product inactive.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-entities" title="Entities">
            <ul className={list}>
                <li>
                    <strong>Fields:</strong> entity code (required, up to 60) and
                    description (up to 2000). The list is sorted by code.
                </li>
                <li>
                    <strong>Used in:</strong> the project form, where an entity
                    is <em>required on shared projects</em> and can't be cleared
                    later, and the time CSV columns <em>Entity code</em> and{' '}
                    <em>Entity description</em>.
                </li>
                <li>You can't delete an entity while a project uses it.</li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-countries" title="Countries">
            <ul className={list}>
                <li>
                    <strong>Fields:</strong> name (up to 100, unique) and an
                    optional 3-letter <em>code</em>. Leave the code empty to use
                    the standard ISO code for the name — the row then shows it
                    with “code set automatically (ISO)”.
                </li>
                <li>
                    <strong>Used in:</strong> the Country dropdown on the{' '}
                    <L to="/clients">client</L> form, and as suggestions for
                    Country on a user profile. A project takes its country from
                    its client; it's read-only on the project form.
                </li>
                <li>
                    <strong>Project codes</strong> look like{' '}
                    <code>P26-USA-0001</code>: year, the country's code, then a
                    number that restarts each year for each country. The country
                    code is the one set here, otherwise the ISO code for the
                    name ("United States" or "USA" → USA, "Germany" → DEU,
                    "Serbia" → SRB, "United Kingdom" or "UK" → GBR), otherwise
                    the first three letters of the name; <code>INT</code> when
                    there's no country. The code is set once, when the project
                    is created — existing project codes never change.
                </li>
                <li>
                    Countries are saved as text, so renaming, hiding or deleting
                    one doesn't change existing clients, projects or codes.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-business-units" title="Business units">
            <ul className={list}>
                <li>
                    <strong>Field:</strong> name (up to 100, unique).
                </li>
                <li>
                    <strong>Used in:</strong> user profiles (only admins can
                    change someone's unit), the admin user form, the profile page
                    and the people directory, where you can search by unit.
                </li>
                <li>
                    An inactive unit can't be given to anyone new, but users who
                    have it keep it. Deleting a unit removes it from those users.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-app-os" title="Target OS options">
            <ul className={list}>
                <li>
                    <strong>Field:</strong> name (up to 100, unique). Keep names
                    under 60 characters, because a release can't store longer
                    values.
                </li>
                <li>
                    <strong>Used in:</strong> the <em>Target OS</em> checklist on
                    the release form in{' '}
                    <L to="/applications">Applications</L>. The chosen values show
                    as chips on release cards and the release page.
                </li>
                <li>
                    Releases save the values as text, so renaming or deleting an
                    option doesn't change existing releases; old values remain as
                    removable chips.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-app-pos-terminals" title="POS terminal types">
            <ul className={list}>
                <li>
                    Works exactly like Target OS options, for the release form's{' '}
                    <em>POS terminal type</em> checklist (e.g. Verifone P200,
                    Ingenico iSC250).
                </li>
                <li>
                    This is separate from <strong>Terminals</strong> under
                    Tickets, which is the help-desk catalogue of vendors and
                    models.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-ticket-types" title="Ticket types">
            <p>
                Ticket types are the cards requesters choose from on the portal.{' '}
                <em>New type</em> or the pencil opens a dialog with two tabs.
                Types are listed by name.
            </p>
            <ul className={list}>
                <li>
                    <strong>Details, left column</strong>:
                    <ul className="ml-5 mt-1 list-[circle] space-y-1">
                        <li>
                            <em>Name</em>, up to 120 characters.
                        </li>
                        <li>
                            <em>Description</em>, up to 255. It appears under
                            the card and as the subtitle of the raise form.
                        </li>
                        <li>
                            <em>Icon</em> and <em>Colour</em>. They tint the
                            card, the type badges and the ticket header.
                        </li>
                        <li>
                            <em>Default priority</em>, pre-selected on the raise
                            form. <em>None</em> means Normal.
                        </li>
                        <li>
                            <em>Status</em>. <em>Inactive</em> hides the card;
                            existing tickets keep their type.
                        </li>
                        <li>
                            <em>Who can see these tickets</em>. Leave it empty
                            for every agent. Pick agents to make a private
                            queue: only they (plus admins and anyone with{' '}
                            <em>View all tickets</em>) see its tickets, and only
                            they get the "new ticket" notification. Other agents
                            see a ticket only if they're its assignee, reporter
                            or participant, or it was shared with them.
                        </li>
                    </ul>
                </li>
                <li>
                    <strong>Details, right column: custom fields</strong>,
                    available after the first save. A field is <em>Terminal</em>{' '}
                    (OS → Vendor → Model, from Terminals), <em>Client</em>{' '}
                    (hidden for external requesters, whose organisation is used),{' '}
                    <em>Text</em>, <em>Multi-select</em> (you type the options
                    when adding it; they can't be edited later) or{' '}
                    <em>Yes / No</em>. Each row has ↑ / ↓, a <em>Required</em>{' '}
                    switch, Rename and Delete. A type can have one Terminal and
                    one Client field, and a field's kind can't change. Required
                    fields block the requester's submit; agents aren't forced.
                </li>
                <li>
                    Answers are saved with the ticket when it's raised. Renaming
                    or deleting a field never changes existing tickets. The ticket
                    window shows them in the <em>Client &amp; Terminal</em>,{' '}
                    <em>Contact</em> and <em>Other details</em> cards.
                </li>
                <li>
                    <strong>Help panel</strong>: the column next to that type's
                    raise form. It holds <em>Tips for a good ticket</em> (up to
                    10; empty hides the card; <em>Use the built-in tips</em>{' '}
                    resets them), <em>Related resources</em> (intro text and up to
                    10 http(s) links) and <em>Need urgent help?</em> (text,
                    button label, and a phone number, e-mail or link that becomes
                    a call, e-mail or open-link button). A live preview shows
                    what requesters will see.
                </li>
                <li>
                    <strong>Who can raise which types</strong>:
                    <ul className="ml-5 mt-1 list-[circle] space-y-1">
                        <li>
                            External requesters: <L to="/clients">Clients</L> →
                            edit client → <em>Ticket types this client can
                            raise</em>.
                        </li>
                        <li>
                            Internal requesters: <L to="/users">Users</L> → edit
                            user → Requester (Internal) → <em>Ticket types this
                            user can raise</em>.
                        </li>
                        <li>
                            If nothing is granted, they see no cards. Staff see
                            every active type.
                        </li>
                    </ul>
                </li>
                <li>
                    <strong>Deleting a type</strong>: its tickets stay but lose
                    the type. Its fields, agent list and allowances are removed,
                    and unassigned tickets of a private type go back to the open
                    queue.
                </li>
                <li>
                    Fields created in older versions without a type still appear
                    on every raise form, but they can't be edited here.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-requester-groups" title="Requester groups">
            <ul className={list}>
                <li>
                    Named groups of people, such as "Finance team". Create one
                    with <em>New group</em>: a name plus a searchable checklist
                    of members. Any active user can be a member. Edit or delete
                    from the row.
                </li>
                <li>
                    Requesters find groups in <em>Share with</em> on the raise
                    form and in <em>People → Add</em> on their ticket. Picking a
                    group adds its current members as participants, who can open
                    the ticket and get its replies. Later changes to the group
                    don't affect existing tickets.
                </li>
                <li>Groups grant no permissions.</li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-terminals" title="Terminals">
            <ul className={list}>
                <li>
                    <strong>Vendors</strong> are on the left: add, rename or
                    delete (deleting a vendor also deletes its models).{' '}
                    <strong>Models</strong> of the selected vendor are on the
                    right: add one with a name and OS (Linux or Android), or
                    delete it. Renaming a model isn't available here yet, and
                    deleting one clears it from its tickets, so add the new
                    model rather than deleting the old one.
                </li>
                <li>
                    Only the ticket <em>Terminal</em> field uses this list (OS →
                    Vendor → Model). A ticket shows "Vendor Model - OS". Deleting
                    a model clears it from tickets that used it.
                </li>
            </ul>
        </HelpSubTopic>

        <HelpSubTopic id="templates-wallboards" title="Wallboards">
            <ul className={list}>
                <li>
                    A <strong>wallboard</strong> is a big-screen board of all open
                    tickets for a TV in the support room. Name the screen and{' '}
                    <em>Create link</em>; then <em>Copy link</em> (or{' '}
                    <em>Open</em>) and open it in the TV's browser — no sign-in
                    is needed.
                </li>
                <li>
                    The link is the only key, so <strong>anyone who has it sees
                    the board</strong>: code, title, ticket type, priority,
                    status, age and who is handling each open ticket. Internal
                    tickets, descriptions, clients and requesters are never
                    shown. Give every screen its own link.
                </li>
                <li>
                    <em>Pause link</em> turns a screen off right away (and{' '}
                    <em>Resume link</em> back on); <em>New link</em> replaces the
                    key — the old link stops working, so open the new one on the
                    screen; <em>Delete</em> removes it. The row shows when a
                    screen last loaded it.
                </li>
                <li>
                    On the screen: columns New / In progress / Pending,
                    counters (active, new today, unassigned, urgent, resolved
                    today). Updates arrive instantly over the live connection
                    (green <em>Live</em> badge); if that's blocked, the board
                    checks every 10 seconds instead. A new ticket pops up for
                    10 seconds with a chime and then glows in its column.
                    Browsers only play sound after one click on the page: click{' '}
                    <em>Turn on sound for new tickets</em> once after opening it
                    (the speaker icon mutes). To skip that click on a dedicated
                    TV, start Chrome with{' '}
                    <code>--autoplay-policy=no-user-gesture-required</code>{' '}
                    (or allow autoplay for the site in Firefox). Use the
                    full-screen button for a clean view.
                </li>
            </ul>
        </HelpSubTopic>
    </>
);
