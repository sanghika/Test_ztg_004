import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateForAuthenticatedUser } = vi.hoisted(() => ({
  mockCreateForAuthenticatedUser: vi.fn(),
}));

vi.mock("octokit", () => ({
  Octokit: vi.fn().mockImplementation(function (this: any) {
    this.rest = {
      repos: {
        createForAuthenticatedUser: mockCreateForAuthenticatedUser,
      },
    };
  }),
}));

import { createRepository } from "./githubService";

describe("createRepository", () => {
  beforeEach(() => {
    mockCreateForAuthenticatedUser.mockReset();
  });

  it("creates a repo with the requested name and visibility, and returns the API response", async () => {
    const fakeRepo = { name: "ziptogit.in_new1", full_name: "octocat/ziptogit.in_new1", private: false };
    mockCreateForAuthenticatedUser.mockResolvedValue({ data: fakeRepo });

    const result = await createRepository("token", "ziptogit.in_new1", false);

    expect(mockCreateForAuthenticatedUser).toHaveBeenCalledWith({
      name: "ziptogit.in_new1",
      private: false,
      auto_init: false,
    });
    expect(result).toEqual(fakeRepo);
  });

  it("passes private: true through when requested", async () => {
    mockCreateForAuthenticatedUser.mockResolvedValue({ data: { name: "secret-repo", private: true } });

    await createRepository("token", "secret-repo", true);

    expect(mockCreateForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ name: "secret-repo", private: true })
    );
  });

  it("raises a clear message when a repo with that name already exists", async () => {
    mockCreateForAuthenticatedUser.mockRejectedValue({
      status: 422,
      response: { data: { message: "name already exists on this account" } },
    });

    await expect(createRepository("token", "taken-name", false)).rejects.toThrow(/already exists/i);
  });

  it("surfaces GitHub's validation detail for other 422 errors", async () => {
    mockCreateForAuthenticatedUser.mockRejectedValue({
      status: 422,
      response: {
        data: {
          message: "Validation Failed",
          errors: [{ message: "name can only contain ASCII letters, digits, and the characters ., -, and _" }],
        },
      },
    });

    await expect(createRepository("token", "bad name!", false)).rejects.toThrow(/can only contain/i);
  });

  it("re-throws non-422 errors unchanged", async () => {
    const networkError = new Error("network down");
    mockCreateForAuthenticatedUser.mockRejectedValue(networkError);

    await expect(createRepository("token", "whatever", false)).rejects.toThrow("network down");
  });
});
