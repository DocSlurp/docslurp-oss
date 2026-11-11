#set page(width: 612pt, height: 792pt, margin: 72pt)
#set text(font: "DejaVu Sans", size: 11pt)
#let body(n) = [This is benign authored paragraph #n used to give the page some ordinary body text for the converter to read. It carries no meaning beyond filling a line or two of prose.]
= Repeated figure test
#body(1)
#image("logo.png", width: 200pt)
#body(2)
#pagebreak()
#body(3)
#image("logo.png", width: 200pt)
#body(4)
#pagebreak()
#body(5)
#box(width: 300pt, height: 200pt, {
  for i in range(0, 12) {
    place(line(start: (0pt, i * 16pt), end: (300pt, 200pt - i * 16pt), stroke: 0.8pt + blue))
    place(circle(radius: 6pt + i * 6pt, stroke: 0.6pt + red))
  }
})
#body(6)
#pagebreak()
#body(7)
#image("logo.png", width: 200pt)
#body(8)
