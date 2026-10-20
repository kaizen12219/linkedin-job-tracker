const A = "68c123456789abcdef012301", B = "68c123456789abcdef012302";
const escape = (value) => String(value).replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const job = (id = A, values = {}) => ({ id, title: `Software Engineer ${id.slice(-1)}`, company: `Company ${id.slice(-1)}`, workplace: "Remote", description: `Build production software for job ${id}.`, ...values });
function card(value) {
  return `<div class="job-card-flag-classname" id="${value.id}"><a href="/jobs/info/${value.id}"><h2 class="index_job-title__title">${escape(value.title)}</h2><div class="index_company-name__name">${escape(value.company)}</div></a>
    <a href="/jobs/info/${value.id}" data-match="true">90% Match</a><div class="index_job-metadata-item__meta"><svg aria-label="remote"></svg><span>${escape(value.workplace)}</span></div>
    <button data-action="like">Like</button><button data-action="hide">Not interested</button><button data-action="orion">Ask Orion</button><button data-action="apply">Apply now</button></div>`;
}
function details(value) {
  return `<div class="index_jobDetailContent__rhs3U"><div class="index_jobMainContentInfo__detail"><div class="index_jobSimpleIntroduction__intro"><div class="index_company-job__header"><h2>${escape(value.company)} · 5 minutes ago</h2><h1 class="index_job-title__title">${escape(value.title)}</h1></div>
    <div data-time-filter-job="${value.id}" data-time-filter-field="workModel"><svg aria-label="remote"></svg><span title="${escape(value.workplace)}">${escape(value.workplace)}</span></div>
    </div></div><button id="job-detail-close-button">Close</button><button id="apply-now-button-id">Apply Now</button><aside><a class="index_origin__e6tHu" href="https://careers.example.com/${value.id}">Original Job Post</a></aside>
    <section id="overview-1"><p>AI generated summary: lead our teams and own worldwide strategy.</p><div><h2>Why this job matches you</h2><p>Excellent fit based on your profile and AI analysis.</p></div>
    <div><h2>Insider Connections</h2><p>Jane Doe jane.private@example.com Senior VP</p></div>
    <section class="index_sectionContent__prVJT"><div class="index_main___BY9M"><h2>Responsibilities</h2></div><div><span class="index_listText__text">${escape(value.description)}</span></div></section>
    <div><h2>Qualification</h2><div class="flex flex-col gap-3"><h4>Required</h4><div><span class="index_listText__text">5+ years of software engineering. Work with Node and React.</span></div></div>
    <div class="flex flex-col gap-3"><h4>Preferred</h4><div><span class="index_listText__text">Distributed systems experience.</span></div></div></div>
    <section class="index_sectionContent__prVJT"><div class="index_main___BY9M"><h2>Benefits</h2></div><div><span class="index_listText__text">Health insurance and paid time off.</span></div></section>
    <div><h2>Company Leadership</h2><p>Our CEO was a founder and executive leader.</p></div></section></div>`;
}
function page(values = [job()], selected = values[0]) {
  return `<html><body><header><div data-preference-key="country" data-topbar-state="active"><button><span title="United States">United States</span></button></div>
    <div data-preference-key="workLocation" data-topbar-state="active"><button><span title="Remote">Remote</span></button></div></header>
    <main id="jobs-page-main-content">${values.map(card).join("")}</main><aside id="details">${selected ? details(selected) : ""}</aside></body></html>`;
}
module.exports = { A, B, job, card, details, page };
