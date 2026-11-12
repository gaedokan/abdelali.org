---
title: Xcode Debugging Tips That Go Beyond Basic Breakpoints
summary: Five Xcode and LLDB techniques that stop your app closer to the real source of a bug — and spare you from writing temporary debug code.
source: https://www.linkedin.com/pulse/xcode-debugging-tips-tricks-abdel-ali-ja-m-hamed/
---

Setting a breakpoint in Xcode is simple. Click a line number and the app pauses when execution reaches that line. But a standard breakpoint is not always enough.

Xcode provides several powerful debugging tools that can help you find errors earlier and understand where they come from.

## 1. Swift Error Breakpoint

A Swift error can start deep inside your code or inside a dependency. It may then move through several methods before it is handled. A Swift Error Breakpoint pauses execution where the error is first thrown, which makes it easier to find the real source of the problem.

To add one, open the Breakpoint Navigator, select the **+** button and choose **Swift Error Breakpoint**. You can also enter an error type if you only want Xcode to pause for a specific error.

## 2. Exception Breakpoint

An Exception Breakpoint pauses execution when your app raises an exception. This is especially useful for Objective-C code, or frameworks that still use Objective-C exceptions.

To add one, open the Breakpoint Navigator, select **+**, choose **Exception Breakpoint**, and set the exception type to Objective-C when needed. You can add a debugger action with this command to print a readable version of the exception:

```
po $arg1
```

## 3. Symbolic Breakpoint

Sometimes you need to pause inside code that you cannot access directly. A Symbolic Breakpoint lets you pause whenever a specific function or method is called, wherever that symbol appears in the project.

To add one, open the Breakpoint Navigator, select **+**, choose **Symbolic Breakpoint** and enter the method or function name. For example, you can use this symbol to investigate Auto Layout constraint problems:

```
[UIView(UIConstraintBasedLayout) _viewHierarchyUnpreparedForConstraint:]
```

## 4. Change a value at runtime

You do not always need to change your source code to test an edge case. LLDB can modify a variable while the app is running:

```
expression variable = desiredValue
```

You can also add this command as a breakpoint action. To automate the process:

1. Edit the breakpoint
2. Add a **Debugger Command** action
3. Enter the expression
4. Enable **Automatically continue after evaluating actions**

Each time the breakpoint is reached, Xcode changes the value and continues execution. This is useful for testing rare states without adding temporary code.

## 5. Open a debugging tab automatically

When Xcode reaches a breakpoint, it usually opens the file that caused the pause. This can interrupt your current workspace and replace the file you were reading. You can ask Xcode to use a dedicated debugging tab instead:

1. Open Xcode Settings
2. Select **Behaviors**
3. Find **Running** and select **Pauses**
4. Enable **Show tab named** and choose a name such as *Debug*

Xcode will now open that tab whenever execution pauses.

These tools make debugging faster and more focused. They help you stop closer to the source of a problem and reduce the need for temporary code.

Which Xcode debugging feature saves you the most time?
