---
title: A Practical Way to Replace Legacy Code Safely
summary: Replacing legacy code is risky. Here is the step-by-step process our team follows to swap out old implementations without breaking the app.
source: https://www.linkedin.com/pulse/replacing-legacy-code-abdelali-ja-m-hamed/
---

Replacing legacy code can be risky. The old implementation may be difficult to understand. It may also support important behavior that is not documented. The safest approach is to replace it gradually while keeping the application stable.

This guide explains the process our team follows. Every codebase is different, so adapt the steps to your situation.

## 1. Isolate the work

Keep the refactor focused. Use a dedicated branch or a small series of pull requests. Each commit should contain changes related to the refactor.

Avoid mixing feature work with structural changes. A focused change is easier to review and test. It also reduces the chance of merge conflicts. Small pull requests are usually safer than one large replacement.

## 2. Protect existing behavior with tests

Refactoring changes the structure of code without changing its external behavior. Before changing the implementation, we add tests that describe how the existing code works.

These tests create a safety net. They help us detect unexpected behavior changes while the refactor is in progress.

Focus on observable behavior rather than internal details. This allows the implementation to change without forcing every test to change with it. If the legacy code is difficult to test directly, start with higher-level integration tests around its inputs and outputs.

## 3. Deprecate the legacy API

Mark the old implementation as deprecated before replacing it. This tells the team that new code should use the new API. It also gives developers clear migration guidance.

Swift provides the `@available` attribute for this:

```swift
extension CustomClass {
    @available(*, deprecated, renamed: "newMethod()")
    public func oldMethod() {
        // Legacy implementation
    }
}
```

A clear deprecation message should explain what developers should use instead.

## 4. Add an abstraction

Avoid replacing every dependency at once. Introduce an abstraction around the legacy implementation. This could be a protocol or a strategy. It could also be a factory that decides which implementation to create.

```swift
protocol DataProviding {
    func loadData() async throws -> Data
}
```

The legacy implementation can conform to this protocol first. The new implementation can then be developed behind the same interface. This keeps the application working while the migration is in progress.

It also allows both implementations to exist at the same time. You can switch between them during testing, or release the new version gradually.

## 5. Build the new implementation incrementally

Replace one behavior at a time. Run the existing test suite after every meaningful change, and add new tests for cases that were previously missing.

When possible, compare the output of both implementations with the same inputs. The new implementation should become the default only after it has been tested and proven in real use.

## 6. Migrate every caller

A deprecated implementation cannot be removed while other parts of the application still depend on it. Search the entire codebase for remaining references. Update each caller and verify its behavior.

Track the migration so the team can see what remains. The migration is complete when no production code depends on the legacy implementation.

## 7. Communicate with the team

Technical changes also require clear communication. Tell the team when the new implementation is available. Explain why it exists and how to use it. Share:

- The replacement API
- A simple usage example
- Known limitations
- The migration plan
- The expected removal date

Good communication prevents new code from creating more dependencies on the legacy implementation.

## 8. Remove the legacy code

Once every caller has migrated and the new implementation is stable, it is time to remove the old code. Delete the legacy implementation and its outdated tests. Remove temporary adapters and migration flags when they are no longer needed.

Run the complete test suite and verify the most important user flows. Leaving unused legacy code in the project creates confusion. Removing it is the final step of the refactor.

> Replacing legacy code safely is rarely one large change.

It is a controlled process built around tests, clear boundaries, small migrations and good communication.

How does your team approach legacy code?
