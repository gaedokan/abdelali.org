---
title: Exploring Modern Concurrency in Swift
summary: A practical tour of Swift's modern concurrency — tasks, Sendable and actors, async let and task groups, continuations and async streams — with code you can run today.
source: https://medium.com/@gaedokan/exploring-modern-concurrency-in-swift-part1-8b9d7c468406
---

Swift 5.5 introduced robust and integrated tools for handling concurrency, simplifying how we work with asynchronous code. These new tools, built into the language, help prevent data races and allow us to write code that feels synchronous even when dealing with asynchronous operations.

This guide brings together my four-part series on the topic. Let's explore these modern concurrency tools and understand how they improve our workflow.

## Part 1 — Task basics

### Creating a task

The fundamental unit for asynchronous work in Swift is the `Task`. Creating a task is straightforward and similar to how you might create threads or dispatch work items:

```swift
Task {
    print(Thread.current)
}
```

Running this prints the current thread, indicating that a new thread was started for the task. This basic example leads us to the different types a `Task` can have.

### Task types

A task can produce a value or throw an error. This is indicated by the generics `Task` uses:

```swift
let task: Task<Int, Never> = Task {
    return 42
}

let task: Task<Int, Error> = Task {
    struct SomeError: Error {}
    throw SomeError()
    return 42
}
```

The first generic represents the value type, while the second indicates the error type. To handle these values properly, we need to look at how Swift manages asynchronous functions.

### Async functions

To perform asynchronous work, functions need the `async` keyword. This signifies that the function performs asynchronous operations and must be called within an asynchronous context:

```swift
func doSomethingAsync() async {
}

Task {
    await doSomethingAsync()
}
```

Using `await` indicates a suspension point, allowing the task to yield control until the async work completes. This prevents blocking the thread and lets other tasks run in the meantime.

### Task priority

Tasks can have different priority levels, influencing the runtime's scheduling decisions:

```swift
let task = Task(priority: .high) {
    print("High priority task")
}
```

Setting a task's priority helps manage execution more effectively, but sometimes tasks need to be cancelled.

### Task cancellation

Tasks support cancellation, allowing you to terminate a task before it completes. However, cancellation is cooperative, meaning the task must regularly check if it has been cancelled:

```swift
let task = Task {
    guard !Task.isCancelled else { throw TaskWasCancelled() }
    print(Thread.current)
}

task.cancel()
```

Alternatively, you can use `checkCancellation` to throw an error if the task has been cancelled:

```swift
let task = Task {
    try Task.checkCancellation()
    print(Thread.current)
}

task.cancel()
```

### Task locals

Task locals allow you to associate data with a task, which can be accessed throughout the task's execution. This is particularly useful for passing contextual information:

```swift
enum MyLocals {
    @TaskLocal static var id: Int!
}

MyLocals.$id.withValue(42) {
    Task {
        print(MyLocals.id!)
    }
}
```

Task locals are inherited by any new tasks created within their context, ensuring consistent access to this data.

### Task cooperation

Swift's concurrency model relies on cooperation to avoid blocking the limited number of threads available in the runtime. This is achieved by using non-blocking APIs and yielding control periodically:

```swift
for _ in 0..<workCount {
    Task {
        while true {
            await Task.yield()
        }
    }
}
```

Using `await Task.yield()` creates a suspension point, freeing up the task's thread and allowing other tasks to execute. This cooperative behavior enhances the overall performance and responsiveness of your applications.

## Part 2 — Sendable and actors

### Understanding data races

When multiple tasks try to read and write the same data at the same time, it can cause problems called data races. For example, if two tasks try to update the same counter at the same time, the final count might be wrong. To fix this, Swift provides special tools to manage data safely. One of these tools is the `Sendable` protocol.

### The Sendable protocol

The `Sendable` protocol ensures that a type is safe to use in concurrent code. This means you can share it between tasks without worrying about data races:

```swift
struct User: Sendable {
    var id: Int
    var name: String
}
```

In Swift, simple types like integers and strings are safe to share between tasks.

### @Sendable closures

The `@Sendable` attribute ensures that a closure is safe to run concurrently. This means the closure won't cause data races by capturing and changing shared data:

```swift
func perform(work: @escaping @Sendable () -> Void) {
    Task {
        work()
    }
}
```

Let's see a practical example. Without `@Sendable`:

```swift
var count = 0
for _ in 0..<100 {
    Thread.detachNewThread {
        count += 1
    }
}

Thread.sleep(forTimeInterval: 2)
print("count", count)
```

This code might not give the expected result of 100 because of data races. With `@Sendable`:

```swift
func perform(work: @escaping @Sendable () -> Void) {
    Task {
        work()
    }
}

var count = 0
for _ in 0..<100 {
    perform {
        count += 1
    }
}
```

Here, the compiler ensures `count` is not changed in a way that causes data races, making the code safer.

### Actors

Swift 5.5 introduces actors, a new type that helps manage data safely when multiple tasks are running. Actors make sure that only one task can access their data at a time, preventing data races. Here's an actor managing a counter:

```swift
actor Counter {
    var count = 0

    func increment() {
        self.count += 1
    }
}
```

Let's use the `Counter` actor:

```swift
let counter = Counter()
for _ in 0..<100 {
    Task {
        await counter.increment()
    }
}

Thread.sleep(forTimeInterval: 1)
Task {
    print(await counter.count)
}
```

The `await` keyword ensures that one task updates the count at a time. Actors remove the need for manual locking, making your code cleaner and easier to understand.

## Part 3 — Running work in parallel

Even with powerful tools to prevent data races, non-determinism can creep into our code when firing off multiple concurrent tasks. Swift's concurrency tools are designed to address data races, not to eliminate non-determinism.

### async let

`async let` allows us to write asynchronous and concurrent code in a structured manner, similar to traditional top-to-bottom code. Suppose you need to fetch user data and a feed simultaneously. With `async let`, you can start both tasks at the same time and await their results together:

```swift
struct User {
    var id: Int
}

struct Feed {
    var id: Int
}

func fetchUser() async throws -> User {
    // Simulate a network call
    try await Task.sleep(nanoseconds: 200_000_000)
    return User(id: 1)
}

func fetchFeed() async throws -> Feed {
    // Simulate a network call
    try await Task.sleep(nanoseconds: 200_000_000)
    return Feed(id: 101)
}

// Usage — concurrent execution
async let user = fetchUser()
async let feed = fetchFeed()

let userResult = try await user
let feedResult = try await feed
```

Both tasks run concurrently, saving time while keeping the code clean and easy to follow. Unlike manually managing tasks, `async let` handles cancellation and error propagation for you.

### Task groups

While `async let` is excellent for a known number of tasks, sometimes the number of tasks varies. In those cases, task groups let you manage dynamic parallelism. Here we add tasks dynamically and sum their results:

```swift
let sum = try await withThrowingTaskGroup(of: Int.self) { group -> Int in
    for n in 1...1_000 {
        group.addTask {
            // Simulate some work
            try await Task.sleep(nanoseconds: NSEC_PER_SEC / 1000)
            return n
        }
    }

    var sum = 0
    for try await result in group {
        sum += result
    }

    return sum
}

print("Sum of 1 to 1000: \(sum)")
```

All tasks run concurrently, and results are processed as soon as they're available.

## Part 4 — Bridging old code: continuations and async streams

Swift's concurrency tools also provide mechanisms to bridge older, callback-based code with modern async/await patterns.

### Bridging a delegate-based API

Consider an API that uses a delegate to notify when a task is completed. We can convert it to an async function using `withCheckedContinuation`:

```swift
protocol DataFetcherDelegate {
    func didFetchData(_ data: String)
}

class DataFetcher {
    var delegate: DataFetcherDelegate?

    func fetchData() {
        // Simulate an asynchronous data fetch
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            self.delegate?.didFetchData("Fetched data")
        }
    }
}

extension DataFetcher {
    func fetchDataAsync() async -> String {
        return await withCheckedContinuation { continuation in
            self.delegate = DelegateWrapper(continuation: continuation)
            self.fetchData()
        }
    }

    private class DelegateWrapper: DataFetcherDelegate {
        let continuation: CheckedContinuation<String, Never>

        init(continuation: CheckedContinuation<String, Never>) {
            self.continuation = continuation
        }

        func didFetchData(_ data: String) {
            continuation.resume(returning: data)
        }
    }
}

// Usage
let dataFetcher = DataFetcher()
Task {
    let data = await dataFetcher.fetchDataAsync()
    print(data) // "Fetched data"
}
```

`DelegateWrapper` conforms to `DataFetcherDelegate`, captures the continuation, and resumes it when the delegate method is called.

### Bridging a closure-based API

Similarly, we can bridge a closure-based API:

```swift
class NetworkManager {
    func fetchData(completion: @escaping (String) -> Void) {
        // Simulate an asynchronous network call
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            completion("Network data")
        }
    }
}

extension NetworkManager {
    func fetchDataAsync() async -> String {
        return await withCheckedContinuation { continuation in
            self.fetchData { data in
                continuation.resume(returning: data)
            }
        }
    }
}

// Usage
let networkManager = NetworkManager()
Task {
    let data = await networkManager.fetchDataAsync()
    print(data) // "Network data"
}
```

### Async streams

`AsyncStream` handles sequences of values asynchronously — useful for continuous data such as incoming messages or sensor readings. Here's a provider that emits a value every second:

```swift
class DataProvider {
    private var timer: Timer?

    func startEmitting() -> AsyncStream<Int> {
        return AsyncStream { continuation in
            var count = 0
            self.timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
                continuation.yield(count)
                count += 1
                if count > 5 {
                    continuation.finish()
                    self.timer?.invalidate()
                }
            }
        }
    }
}

// Usage
let dataProvider = DataProvider()
Task {
    for await value in dataProvider.startEmitting() {
        print("Received value: \(value)")
    }
}
```

`continuation.yield` sends values into the stream, and `continuation.finish` closes it.

## Conclusion

Swift's modern concurrency tools — tasks, `Sendable`, actors, `async let`, task groups, continuations and async streams — provide a powerful, ergonomic and safe way to handle asynchronous work. By integrating them deeply into the language, Swift replaces traditional threading models with a more manageable, scalable and intuitive approach. Use them to modernize your codebase and make it more readable and maintainable.
