function createTicketService({ cloudbase, memberStore, createTicket } = {}) {
  const issue = createTicket || ((uid) => cloudbase.auth().createTicket(uid));
  return {
    async issueForUid(uid) {
      const member = await memberStore.findByUid(uid);
      if (!member || (member.role !== "admin" && member.role !== "member")) {
        const error = new Error(member?.role === "pending" ? "PENDING_APPROVAL" : "NOT_AUTHORIZED");
        error.code = error.message;
        throw error;
      }
      return issue(uid);
    },
  };
}

module.exports = { createTicketService };
